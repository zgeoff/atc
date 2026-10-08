import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventMsg } from '../src/protocol/protocol';
import { getRecord } from '../src/shared/get-record';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';
import { waitForEvent } from '../src/test-utils/wait-for-event';

/**
 * A home with a stub Claude CLI and an empty config directory, for the
 * `atc daemon` that each test starts once it has written the config
 * offering the stub.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-sessions-');
  const atc = resolveATCCommand();
  const configDir = join(tmp.dir, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: tmp.dir,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(tmp.dir, { atc, composer: createStubComposer(tmp.dir) }),
  };
}

test('it spawns a session and broadcasts SessionAdded to every client', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const actor = await daemon.openClient();

  const actorEvents: EventMsg[] = [];

  actor.onEvent = (event) => {
    actorEvents.push(event);
  };

  await actor.sendHello('atc/test');

  const ok = await actor.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });
  const added = await waitForEvent(events, { ev: 'SessionAdded' });
  const actorAdded = await waitForEvent(actorEvents, { ev: 'SessionAdded' });

  expect(ok).toStrictEqual({
    session: expect.objectContaining({ kind: 'pty', alive: true }),
  });

  expect(added).toMatchObject({
    session: { id: getRecord(ok, 'session')['id'], cwd: ctx.home, state: 'running' },
  });

  expect(actorAdded).toStrictEqual(added);
});

test('it turns hook notifications into SessionState broadcasts', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const changed = await waitForEvent(events, {
    ev: 'SessionState',
    session: { state: 'needs_you' },
  });

  const listed = await client.sendRequest('session.list');

  expect(changed).toMatchObject({ session: { lastMsg: 'needs permission' } });

  expect(listed).toMatchObject({
    sessions: [{ state: 'needs_you', lastMsg: 'needs permission', agentSessionID: 'fake-1' }],
  });
});

test('it renames and pins a session through session.update', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.update', { session: id, name: 'auth-bug', pinned: true });

  const renamed = await waitForEvent(events, { ev: 'SessionRenamed', name: 'auth-bug' });
  const listed = await client.sendRequest('session.list');

  expect(renamed).toMatchObject({ s: id, namedBy: 'user' });
  expect(listed).toMatchObject({ sessions: [{ name: 'auth-bug', pinned: true, namedBy: 'user' }] });
});

test('it unpins a pinned session through session.update', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.update', { session: id, pinned: true });
  await client.sendRequest('session.update', { session: id, pinned: false });

  const listed = await client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, pinned: false }] });
});

test('it rejects session.update on an unknown session with no_such_session', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  expect(
    client.sendRequest('session.update', { session: 'nope', name: 'x' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it kills a live session to exited', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.kill', { session: id });

  const killed = await waitForEvent(events, {
    ev: 'SessionState',
    session: { lastMsg: 'killed' },
  });

  const listed = await client.sendRequest('session.list');

  expect(killed).toMatchObject({ session: { id, state: 'exited', alive: false } });
  expect(listed).toMatchObject({ sessions: [{ id, state: 'exited', alive: false }] });
});

test('it removes a killed session on a second kill', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  await client.sendRequest('session.kill', { session: id });

  const removed = await waitForEvent(events, { ev: 'SessionRemoved' });
  const listed = await client.sendRequest('session.list');

  expect(removed).toMatchObject({ s: id });
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it builds a resume command once the claude id is captured', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(events, { ev: 'SessionState', session: { agentSessionID: 'fake-1' } });

  const answer = await client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({
    command: `cd '${ctx.home}' && ${ctx.claude} --resume fake-1`,
  });
});

test('it broadcasts PermissionRequested when a session needs input', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });
  const requested = await waitForEvent(events, { ev: 'PermissionRequested' });

  expect(requested).toMatchObject({
    s: getRecord(ok, 'session')['id'],
    message: 'needs permission',
    respondable: false,
    request: expect.toBeString(),
  });
});

test('it answers permission.respond on a keystroke-only request with unsupported', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');
  await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const requested = await waitForEvent(events, { ev: 'PermissionRequested' });

  expect(
    client.sendRequest('permission.respond', {
      request: getString(requested, 'request'),
      decision: 'allow',
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it resolves a pending permission request as dismissed when the session dies', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const requested = await waitForEvent(events, { ev: 'PermissionRequested' });

  const request = getString(requested, 'request');

  await client.sendRequest('session.kill', { session: id });

  const resolved = await waitForEvent(events, { ev: 'PermissionResolved', request });

  expect(resolved).toMatchObject({ decision: 'dismissed' });
});

test('it keeps the last screen of a killed session readable', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_UP');
  });

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  const screen = await client.sendRequest('session.screen', { session: id });

  expect(screen['text']).toInclude('FAKE_CLAUDE_UP');
});

test.each([
  ['session.input', { d: 'x' }],
  ['session.submit', { text: 'x' }],
  ['session.attach', { cols: 80, rows: 24 }],
])('it answers %s on a dead session with session_dead', async (method, params) => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await client.sendRequest('session.kill', { session: id });

  await waitForEvent(events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  expect(client.sendRequest(method, { session: id, ...params })).rejects.toMatchObject({
    code: 'session_dead',
  });
});

test("it reports a session's pending prompt through session.get while it needs you", async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const start = Date.now();

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'pending-check',
    prompt: 'fix the auth bug',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const record = await client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    prompt: 'fix the auth bug',
    pending: { message: 'needs permission' },
    result: null,
    session: { state: 'needs_you' },
  });

  expect(record['lastActivityAt']).toBeWithin(start, Date.now() + 1);
});

test("it reports a finished turn's last message through session.get", async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    `${JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'fake-1',
      last_assistant_message: 'All tests pass.',
    })}\n`,
  );

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(events, { ev: 'SessionState', session: { state: 'done' } });

  const record = await client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({ result: 'All tests pass.', pending: null });
});
