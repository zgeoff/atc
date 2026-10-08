import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventMsg } from '../src/protocol/protocol';
import { getRecord } from '../src/shared/get-record';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubCodex } from '../src/test-utils/create-stub-codex';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { createStubGrok } from '../src/test-utils/create-stub-grok';
import { getString } from '../src/test-utils/get-string';
import { registerTestCleanup } from '../src/test-utils/register-test-cleanup';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runATC } from '../src/test-utils/run-atc';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';
import { waitForEvent } from '../src/test-utils/wait-for-event';

/**
 * A home with stub Claude, Grok, and Codex CLIs for the `atc daemon` that
 * each test starts once it has written the config offering them.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-hooks-');
  const atc = resolveATCCommand();
  const composer = createStubComposer(tmp.dir);

  return {
    home: tmp.dir,
    atc,
    claude: createStubClaude(tmp.dir, { atc, composer }),
    grok: createStubGrok(tmp.dir, { atc, composer }),
    codex: createStubCodex(tmp.dir, { atc, composer }),
  };
}

test('it keeps a live terminal alive when its session reports an end', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'claude'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: daemon.reporterSocketPath },
    stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fake-1' }),
  });

  const ended = await waitForEvent(events, {
    ev: 'SessionState',
    session: { lastMsg: 'session ended' },
  });

  const listed = await client.sendRequest('session.list');

  expect(ended).toMatchObject({ session: { alive: true, kind: 'pty', state: 'needs_you' } });

  expect(listed).toMatchObject({
    sessions: [{ alive: true, state: 'needs_you', lastMsg: 'session ended' }],
  });
});

test('it stops showing a live terminal as ended once a new session starts in it', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    [
      { hook_event_name: 'Stop', session_id: 'fake-1', last_assistant_message: 'All done.' },
      { hook_event_name: 'SessionEnd', session_id: 'fake-1', reason: 'clear' },
      {
        hook_event_name: 'SessionStart',
        session_id: 'fake-2',
        source: 'clear',
        transcript_path: join(ctx.home, 'fake-transcript-2.jsonl'),
      },
    ]
      .map((ev) => `${JSON.stringify(ev)}\n`)
      .join(''),
  );

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  // The stub sends its hooks one reporter launch at a time, and a loaded
  // runner can spend seconds on each launch, so each wait covers one hook
  // rather than the whole chain.
  await waitForEvent(events, { ev: 'SessionState', session: { agentSessionID: 'fake-1' } });
  await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });
  await waitForEvent(events, { ev: 'SessionState', session: { state: 'done' } });
  await waitForEvent(events, { ev: 'SessionState', session: { lastMsg: 'session ended' } });

  const restarted = await waitForEvent(events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-2' },
  });

  const record = await client.sendRequest('session.get', { session: id });

  expect(restarted).toMatchObject({
    session: { alive: true, kind: 'pty', state: 'done', lastMsg: 'started' },
  });

  expect(record).toMatchObject({
    session: { alive: true, state: 'done', lastMsg: 'started', agentSessionID: 'fake-2' },
  });
});

test('it keeps a gone terminal exited when a late end and start arrive', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

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

test('it marks a grok session done on end-turn Stop', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({ hookEventName: 'stop', sessionId: 'fake-grok-1', reason: 'end_turn' })}\n`,
  );

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const done = await waitForEvent(events, { ev: 'SessionState', session: { state: 'done' } });

  expect(done).toMatchObject({
    session: { id: getRecord(ok, 'session')['id'], agent: 'grok', agentSessionID: 'fake-grok-1' },
  });
});

test('it ignores a grok hook event that names a subagent', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'stop',
      sessionId: 'fake-grok-1',
      reason: 'end_turn',
      subagentType: 'explore',
    })}\n`,
  );

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

  // The daemon records every hook it takes after it has applied it, so a
  // recorded stop is one the session has already seen.
  await waitFor(() => {
    expect(db.query('SELECT event FROM events WHERE atc_id = ?').values(id)).toContainEqual([
      'Stop',
    ]);
  });

  const listed = await client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, state: 'running', agent: 'grok' }] });
});

test('it keeps a grok session needing you when an idle notification follows a permission prompt', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

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

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

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
    from: 'e2e',
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

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

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

    mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

    writeFileSync(
      join(ctx.home, '.config', 'atc', 'config.json'),
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

    const events: EventMsg[] = [];

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

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

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

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
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

  const events: EventMsg[] = [];

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
