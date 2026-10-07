import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventMsg } from '../src/protocol/protocol';
import { getRecord } from '../src/shared/get-record';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubCodex } from '../src/test-utils/create-stub-codex';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { createStubGrok } from '../src/test-utils/create-stub-grok';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runATC } from '../src/test-utils/run-atc';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';
import { waitForEvent } from '../src/test-utils/wait-for-event';

/**
 * A home with stub Claude, Grok, and Codex CLIs and a config that offers
 * them and a Claude gateway, served by an `atc daemon` process, with a
 * client that has sent its handshake and collects every event the daemon
 * sends it.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-e2e-hooks-'));
  const atc = resolveATCCommand();
  const composer = createStubComposer(tmp.dir);
  const claude = createStubClaude(tmp.dir, { atc, composer });

  // The daemon spawns its sessions from the agents the config offers; the
  // gateway runs the stub Claude against an address nothing serves.
  mkdirSync(join(tmp.dir, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(tmp.dir, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: claude },
        grok: { bin: createStubGrok(tmp.dir, { atc, composer }) },
        codex: { bin: createStubCodex(tmp.dir, { atc, composer }) },
        zai: { kind: 'claude', bin: claude, baseURL: 'http://127.0.0.1:9' },
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
    atc,
    daemon,
    client,
    events,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it keeps a live terminal alive when its session reports an end', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'claude'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
    stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fake-1' }),
  });

  const ended = await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { lastMsg: 'session ended' },
  });

  const listed = await ctx.client.sendRequest('session.list');

  expect(ended).toMatchObject({ session: { alive: true, kind: 'pty', state: 'needs_you' } });

  expect(listed).toMatchObject({
    sessions: [{ alive: true, state: 'needs_you', lastMsg: 'session ended' }],
  });
});

test('it stops showing a live terminal as ended once a new session starts in it', async () => {
  await using ctx = await setupTest();

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

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  // The stub sends its hooks one reporter launch at a time, and a loaded
  // runner can spend seconds on each launch, so each wait covers one hook
  // rather than the whole chain.
  await waitForEvent(ctx.events, { ev: 'SessionState', session: { agentSessionID: 'fake-1' } });
  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });
  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'done' } });
  await waitForEvent(ctx.events, { ev: 'SessionState', session: { lastMsg: 'session ended' } });

  const restarted = await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-2' },
  });

  const record = await ctx.client.sendRequest('session.get', { session: id });

  expect(restarted).toMatchObject({
    session: { alive: true, kind: 'pty', state: 'done', lastMsg: 'started' },
  });

  expect(record).toMatchObject({
    session: { alive: true, state: 'done', lastMsg: 'started', agentSessionID: 'fake-2' },
  });
});

test('it keeps a gone terminal exited when a late end and start arrive', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-exit'), '');

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { state: 'exited', alive: false },
  });

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'claude'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
    stdin: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fake-1', reason: 'clear' }),
  });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { lastMsg: 'session ended' } });

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'claude'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'fake-2',
      source: 'clear',
    }),
  });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { agentSessionID: 'fake-2' } });

  const record = await ctx.client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    session: { alive: false, state: 'exited', lastMsg: 'session ended', agentSessionID: 'fake-2' },
  });
});

test('it marks a grok session done on end-turn Stop', async () => {
  await using ctx = await setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({ hookEventName: 'stop', sessionId: 'fake-grok-1', reason: 'end_turn' })}\n`,
  );

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const done = await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'done' } });

  expect(done).toMatchObject({
    session: { id: getRecord(ok, 'session')['id'], agent: 'grok', agentSessionID: 'fake-grok-1' },
  });
});

test('it ignores a grok hook event that names a subagent', async () => {
  await using ctx = await setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'stop',
      sessionId: 'fake-grok-1',
      reason: 'end_turn',
      subagentType: 'explore',
    })}\n`,
  );

  const db = new Database(join(ctx.daemon.stateDir, 'atc.db'), { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const ok = await ctx.client.sendRequest('session.spawn', {
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

  const listed = await ctx.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, state: 'running', agent: 'grok' }] });
});

test('it keeps a grok session needing you when an idle notification follows a permission prompt', async () => {
  await using ctx = await setupTest();

  const db = new Database(join(ctx.daemon.stateDir, 'atc.db'), { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'grok'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
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

  const listed = await ctx.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, state: 'needs_you', agent: 'grok' }] });
});

test('it keeps a nested codex harness from rebinding or answering for the claude session it runs in', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const sent = await ctx.client.sendRequest('session.message', {
    session: id,
    text: 'ping from test',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  await waitForEvent(ctx.events, { ev: 'SessionMessage', status: 'delivered' });

  const childStart = await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'codex'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
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
    env: { ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'nested-codex-1',
      last_assistant_message: 'nested codex output',
    }),
  });

  await waitFor(() => {
    expect(ctx.daemon.readStderr()).toInclude(
      `atc hook event=dropped session=${id} agent=codex hook=Stop`,
    );
  });

  const record = await ctx.client.sendRequest('session.get', { session: id });
  const message = await ctx.client.sendRequest('message.get', { message: messageID });

  expect([childStart.exitCode, childStop.exitCode]).toStrictEqual([0, 0]);

  expect(ctx.daemon.readStderr()).toInclude(
    `atc hook event=dropped session=${id} agent=codex hook=SessionStart`,
  );

  expect(record).toMatchObject({
    session: { agentSessionID: 'fake-1', state: 'needs_you', lastMsg: 'needs permission' },
    result: null,
  });

  expect(message).toMatchObject({ session: id, status: 'delivered' });
  expect(message).not.toContainKey('answer');
});

test('it drops a hook line without an agent at a session whose own hooks carry one', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const child = await runATC({
    command: ctx.atc,
    args: ['hook-report'],
    home: ctx.home,
    env: { ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'nested-codex-1',
      last_assistant_message: 'nested codex output',
    }),
  });

  await waitFor(() => {
    expect(ctx.daemon.readStderr()).toInclude(
      `atc hook event=dropped session=${id} agent= hook=Stop`,
    );
  });

  const record = await ctx.client.sendRequest('session.get', { session: id });

  expect(child.exitCode).toBe(0);

  expect(record).toMatchObject({
    session: { agentSessionID: 'fake-1', state: 'needs_you' },
    result: null,
  });
});

test.each(['resume', 'clear', 'compact'])(
  'it rebinds a claude session to the agent session its own %s starts',
  async (source) => {
    await using ctx = await setupTest();

    const spawned = await ctx.client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');

    await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

    const own = await runATC({
      command: ctx.atc,
      args: ['hook-report', '--agent', 'claude'],
      home: ctx.home,
      env: { ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
      stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-2', source }),
    });

    const rebound = await waitForEvent(ctx.events, {
      ev: 'SessionState',
      session: { agentSessionID: 'fake-2' },
    });

    expect(own.exitCode).toBe(0);
    expect(rebound).toMatchObject({ session: { id, agent: 'claude' } });
  },
);

test('it binds a gateway session through the hook command atc wrote for it', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    agent: 'zai',
  });

  const started = await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { state: 'needs_you' },
  });

  expect(started).toMatchObject({ session: { agent: 'zai', agentSessionID: 'fake-1' } });
});

test('it binds a session from a hook line without an agent while none of its own carried one', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-grok-hold-start'), '');

  const spawned = await ctx.client.sendRequest('session.spawn', {
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
    env: { ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
    stdin: JSON.stringify({ hookEventName: 'session_start', sessionId: 'fake-grok-1' }),
  });

  const bound = await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-grok-1' },
  });

  expect(reporter.exitCode).toBe(0);
  expect(bound).toMatchObject({ session: { id, agent: 'grok' } });
});
