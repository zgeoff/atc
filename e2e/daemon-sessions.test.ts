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
 * A home with a stub Claude CLI and a config that offers it, served by an
 * `atc daemon` process, with a client that has sent its handshake and
 * collects every event the daemon sends it.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-e2e-sessions-'));
  const atc = resolveATCCommand();
  const claude = createStubClaude(tmp.dir, { atc, composer: createStubComposer(tmp.dir) });

  // The daemon spawns its sessions from the agents the config offers.
  mkdirSync(join(tmp.dir, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(tmp.dir, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: claude },
      },
    }),
  );

  const daemon = stack.use(startDaemonProcess({ command: atc, home: tmp.dir }));

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const owned = stack.move();

  return {
    home: tmp.dir,
    claude,
    daemon,
    client,
    events,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it spawns a session and broadcasts SessionAdded to every client', async () => {
  await using ctx = await setupTest();

  const actor = await ctx.daemon.openClient();

  await actor.sendHello('atc/test');

  const ok = await actor.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });
  const added = await waitForEvent(ctx.events, { ev: 'SessionAdded' });

  expect(ok).toMatchObject({ session: { kind: 'pty', alive: true } });
  expect(added).toMatchObject({ session: { id: getRecord(ok, 'session')['id'], cwd: ctx.home } });
});

test('it turns hook notifications into SessionState broadcasts', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const changed = await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { state: 'needs_you' },
  });

  const listed = await ctx.client.sendRequest('session.list');

  expect(changed).toMatchObject({ session: { lastMsg: 'needs permission' } });

  expect(listed).toMatchObject({
    sessions: [{ state: 'needs_you', lastMsg: 'needs permission', agentSessionID: 'fake-1' }],
  });
});

test('it renames and pins a session through session.update', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.client.sendRequest('session.update', { session: id, name: 'auth-bug', pinned: true });

  const renamed = await waitForEvent(ctx.events, { ev: 'SessionRenamed', name: 'auth-bug' });
  const listed = await ctx.client.sendRequest('session.list');

  expect(renamed).toMatchObject({ s: id, namedBy: 'user' });
  expect(listed).toMatchObject({ sessions: [{ name: 'auth-bug', pinned: true, namedBy: 'user' }] });
});

test('it unpins a pinned session through session.update', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.client.sendRequest('session.update', { session: id, pinned: true });
  await ctx.client.sendRequest('session.update', { session: id, pinned: false });

  const listed = await ctx.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, pinned: false }] });
});

test('it rejects session.update on an unknown session with no_such_session', async () => {
  await using ctx = await setupTest();

  expect(
    ctx.client.sendRequest('session.update', { session: 'nope', name: 'x' }),
  ).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it stops the daemon process on daemon.quit', async () => {
  await using ctx = await setupTest();

  const answer = await ctx.client.sendRequest('daemon.quit');
  const code = await ctx.daemon.proc.exited;

  expect(answer).toStrictEqual({});
  expect(code).toBe(0);
});

test('it kills a live session to exited', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.client.sendRequest('session.kill', { session: id });

  const killed = await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { lastMsg: 'killed' },
  });

  const listed = await ctx.client.sendRequest('session.list');

  expect(killed).toMatchObject({ session: { id, state: 'exited', alive: false } });
  expect(listed).toMatchObject({ sessions: [{ id, state: 'exited', alive: false }] });
});

test('it removes a killed session on a second kill', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.client.sendRequest('session.kill', { session: id });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  await ctx.client.sendRequest('session.kill', { session: id });

  const removed = await waitForEvent(ctx.events, { ev: 'SessionRemoved' });
  const listed = await ctx.client.sendRequest('session.list');

  expect(removed).toMatchObject({ s: id });
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it builds a resume command once the claude id is captured', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { agentSessionID: 'fake-1' } });

  const answer = await ctx.client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({
    command: `cd '${ctx.home}' && ${ctx.claude} --resume fake-1`,
  });
});

test('it broadcasts PermissionRequested when a session needs input', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });
  const requested = await waitForEvent(ctx.events, { ev: 'PermissionRequested' });

  expect(requested).toMatchObject({
    s: getRecord(ok, 'session')['id'],
    message: 'needs permission',
    respondable: false,
    request: expect.toBeString(),
  });
});

test('it answers permission.respond on a keystroke-only request with unsupported', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const requested = await waitForEvent(ctx.events, { ev: 'PermissionRequested' });

  expect(
    ctx.client.sendRequest('permission.respond', {
      request: getString(requested, 'request'),
      decision: 'allow',
    }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test('it resolves a pending permission request as dismissed when the session dies', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const requested = await waitForEvent(ctx.events, { ev: 'PermissionRequested' });

  const request = getString(requested, 'request');

  await ctx.client.sendRequest('session.kill', { session: id });

  const resolved = await waitForEvent(ctx.events, { ev: 'PermissionResolved', request });

  expect(resolved).toMatchObject({ decision: 'dismissed' });
});

test('it keeps the last screen of a killed session readable', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitFor(async () => {
    const read = await ctx.client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_UP');
  });

  await ctx.client.sendRequest('session.kill', { session: id });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  const screen = await ctx.client.sendRequest('session.screen', { session: id });

  expect(screen['text']).toInclude('FAKE_CLAUDE_UP');
});

test.each([
  ['session.input', { d: 'x' }],
  ['session.submit', { text: 'x' }],
  ['session.attach', { cols: 80, rows: 24 }],
])('it answers %s on a dead session with session_dead', async (method, params) => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await ctx.client.sendRequest('session.kill', { session: id });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  expect(ctx.client.sendRequest(method, { session: id, ...params })).rejects.toMatchObject({
    code: 'session_dead',
  });
});

test("it reports a session's pending prompt through session.get while it needs you", async () => {
  await using ctx = await setupTest();

  const start = Date.now();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'pending-check',
    prompt: 'fix the auth bug',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const record = await ctx.client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    prompt: 'fix the auth bug',
    pending: { message: 'needs permission' },
    result: null,
    session: { state: 'needs_you' },
  });

  expect(record['lastActivityAt']).toBeWithin(start, Date.now() + 1);
});

test("it reports a finished turn's last message through session.get", async () => {
  await using ctx = await setupTest();

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    `${JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'fake-1',
      last_assistant_message: 'All tests pass.',
    })}\n`,
  );

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'done' } });

  const record = await ctx.client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({ result: 'All tests pass.', pending: null });
});
