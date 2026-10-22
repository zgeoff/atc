import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import type { DaemonEvent } from '@atc/protocol';
import {
  createStubClaude,
  createStubCodex,
  createStubComposer,
  createStubGrok,
  getRecord,
  getString,
  registerTestCleanup,
  resolveATCCommand,
  runATC,
  setupTempDir,
  waitFor,
  waitForEvent,
} from '@atc/test-utils';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-hooks-');
  const atc = resolveATCCommand();
  const composer = createStubComposer(temporaryDirectory.path);
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(temporaryDirectory.path, { atc, composer }),
    grok: createStubGrok(temporaryDirectory.path, { atc, composer }),
    codex: createStubCodex(temporaryDirectory.path, { atc, composer }),
  };
}

test('it keeps a gone terminal exited when a late end and start arrive', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-exit'), '');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(events, {
    ev: 'SessionState',
    session: { state: 'exited', alive: false },
  });

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'claude'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fake-1', reason: 'clear' }),
  });

  await waitForEvent(events, { ev: 'SessionState', session: { lastMsg: 'session ended' } });

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'claude'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'fake-2',
      source: 'clear',
    }),
  });

  await waitForEvent(events, { ev: 'SessionState', session: { agentSessionID: 'fake-2' } });

  const record = await client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    session: { alive: false, state: 'exited', lastMsg: 'session ended', agentSessionID: 'fake-2' },
  });
});

test('it keeps a grok session needing you when an idle notification follows a permission prompt', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const db = new Database(join(daemon.stateDir, 'atc.db'), { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'grok'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hookEventName: 'notification',
      sessionId: 'fake-grok-1',
      notificationType: 'idle_prompt',
    }),
  });

  // The daemon records every hook it takes after it has applied it, so a
  // second recorded notification is one the session has already seen.
  await waitFor(() => {
    expect(
      db.query("SELECT event FROM events WHERE atc_id = ? AND event = 'Notification'").values(id),
    ).toHaveLength(2);
  });

  const listed = await client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, state: 'needs_you', agent: 'grok' }] });
});

test('it keeps a nested codex harness from rebinding or answering for the claude session it runs in', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const sent = await client.sendRequest('session.message', {
    session: id,
    text: 'ping from test',
  });

  const messageID = getString(sent, 'message');

  await waitForEvent(events, { ev: 'SessionMessage', status: 'delivered' });

  const childStart = await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'codex'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'nested-codex-1',
      transcript_path: `${ctx.home}/nested-rollout.jsonl`,
      source: 'startup',
    }),
  });

  const childStop = await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'codex'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'nested-codex-1',
      last_assistant_message: 'nested codex output',
    }),
  });

  await waitFor(() => {
    expect(daemon.readStderr()).toIncludeMultiple([
      `atc hook event=dropped session=${id} agent=codex hook=SessionStart`,
      `atc hook event=dropped session=${id} agent=codex hook=Stop`,
    ]);
  });

  const record = await client.sendRequest('session.get', { session: id });
  const message = await client.sendRequest('message.get', { message: messageID });

  expect(childStart.exitCode).toBe(0);
  expect(childStop.exitCode).toBe(0);

  expect(record).toMatchObject({
    session: { agentSessionID: 'fake-1', state: 'needs_you', lastMsg: 'needs permission' },
    result: null,
  });

  expect(message).toMatchObject({ session: id, status: 'delivered' });
  expect(message).not.toContainKey('answer');
});

test('it drops a hook line without an agent at a session whose own hooks carry one', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const child = await runATC({
    command: ctx.atc,
    args: ['hook-report'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'nested-codex-1',
      last_assistant_message: 'nested codex output',
    }),
  });

  await waitFor(() => {
    expect(daemon.readStderr()).toInclude(`atc hook event=dropped session=${id} agent= hook=Stop`);
  });

  const record = await client.sendRequest('session.get', { session: id });

  expect(child.exitCode).toBe(0);

  expect(record).toMatchObject({
    session: { agentSessionID: 'fake-1', state: 'needs_you' },
    result: null,
  });
});

test.each(['resume', 'clear', 'compact'])(
  'it rebinds a claude session to the agent session its own %s starts',
  async (source) => {
    const ctx = setupTest();

    writeFileSync(
      ctx.configPath,
      JSON.stringify({
        agents: {
          claude: { bin: ctx.claude },
          grok: { bin: ctx.grok },
          codex: { bin: ctx.codex },

          // The gateway runs the stub Claude against an address nothing serves.
          zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
        },
      }),
    );

    const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

    const client = await daemon.openClient();

    const events: DaemonEvent[] = [];

    client.onEvent = (event) => {
      events.push(event);
    };

    await client.sendHello('atc/test');

    const spawned = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');

    await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

    const own = await runATC({
      command: ctx.atc,
      args: ['hook-report', '--agent', 'claude'],
      home: ctx.home,
      env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
      stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-2', source }),
    });

    const rebound = await waitForEvent(events, {
      ev: 'SessionState',
      session: { agentSessionID: 'fake-2' },
    });

    expect(own.exitCode).toBe(0);
    expect(rebound).toMatchObject({ session: { id, agent: 'claude' } });
  },
);

test('it binds a gateway session through the hook command atc wrote for it', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    agent: 'zai',
  });

  const started = await waitForEvent(events, {
    ev: 'SessionState',
    session: { state: 'needs_you' },
  });

  expect(started).toMatchObject({ session: { agent: 'zai', agentSessionID: 'fake-1' } });
});

test('it binds a session from a hook line without an agent while none of its own carried one', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-grok-hold-start'), '');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    agent: 'grok',
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const reporter = await runATC({
    command: ctx.atc,
    args: ['hook-report'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({ hookEventName: 'session_start', sessionId: 'fake-grok-1' }),
  });

  const bound = await waitForEvent(events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-grok-1' },
  });

  expect(reporter.exitCode).toBe(0);
  expect(bound).toMatchObject({ session: { id, agent: 'grok' } });
});
