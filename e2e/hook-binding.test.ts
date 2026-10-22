import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runHookReport } from '@atc/reporters';
import { runTap } from '@atc/reporters/tap';
import {
  getRecord,
  getString,
  registerTestCleanup,
  updateEnv,
  waitFor,
  waitForEvent,
} from '@atc/test-utils';
import { z } from 'zod';
import { startStubAgentDaemon } from '../packages/app/src/test-utils/start-stub-agent-daemon';

// A daemon in the test's process whose agents are the in-process stand-ins,
// which report their hooks over the daemon's real reporter socket. A test
// that reports a hook itself runs the real hook reporter in its own process.
function setupTest() {
  return startStubAgentDaemon({
    agents: (bins) => ({
      claude: { bin: bins.claude },
      grok: { bin: bins.grok },

      // The gateway runs the stand-in Claude against an address nothing serves.
      zai: { kind: 'claude', bin: bins.claude, baseURL: 'http://127.0.0.1:9' },
    }),
  });
}

test('it keeps a live terminal alive when its session reports an end', async () => {
  const ctx = await setupTest();

  ctx.agents.loadEvents('claude', [
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
    { hook_event_name: 'SessionEnd', session_id: 'fake-1' },
  ]);

  await ctx.daemon.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const ended = await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { lastMsg: 'session ended' },
  });

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(ended).toMatchObject({ session: { alive: true, kind: 'pty', state: 'needs_you' } });

  expect(listed).toMatchObject({
    sessions: [{ alive: true, state: 'needs_you', lastMsg: 'session ended' }],
  });
});

test('it stops showing a live terminal as ended once a new session starts in it', async () => {
  const ctx = await setupTest();

  ctx.agents.loadEvents('claude', [
    { hook_event_name: 'Stop', session_id: 'fake-1', last_assistant_message: 'All done.' },
    { hook_event_name: 'SessionEnd', session_id: 'fake-1', reason: 'clear' },
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-2',
      source: 'clear',
      transcript_path: join(ctx.home, 'fake-transcript-2.jsonl'),
    },
  ]);

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { lastMsg: 'session ended' },
  });

  const restarted = await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-2' },
  });

  const record = await ctx.daemon.client.sendRequest('session.get', { session: id });

  expect(restarted).toMatchObject({
    session: { alive: true, kind: 'pty', state: 'done', lastMsg: 'started' },
  });

  expect(record).toMatchObject({
    session: { alive: true, state: 'done', lastMsg: 'started', agentSessionID: 'fake-2' },
  });
});

test('it marks a grok session done on end-turn Stop', async () => {
  const ctx = await setupTest();

  ctx.agents.loadEvents('grok', [
    { hookEventName: 'stop', sessionId: 'fake-grok-1', reason: 'end_turn' },
  ]);

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const done = await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { state: 'done' },
  });

  expect(done).toMatchObject({
    session: { id: getRecord(ok, 'session')['id'], agent: 'grok', agentSessionID: 'fake-grok-1' },
  });
});

test('it ignores a grok hook event that names a subagent', async () => {
  const ctx = await setupTest();

  ctx.agents.loadEvents('grok', [
    {
      hookEventName: 'stop',
      sessionId: 'fake-grok-1',
      reason: 'end_turn',
      subagentType: 'explore',
    },
  ]);

  const db = new Database(ctx.daemon.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
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

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, state: 'running', agent: 'grok' }] });
});

test('it keeps a gone terminal exited when a late end and start arrive', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  ctx.agents.sessions[0]?.harness.emitExit({ exitCode: 0 });

  await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { state: 'exited', alive: false },
  });

  updateEnv('ATC_SESSION_ID', id);
  updateEnv('ATC_SOCKET', ctx.daemon.reporterSocketPath);

  await runHookReport('claude', {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fake-1', reason: 'clear' }),
      ),
    exit: () => {},
  });

  await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { lastMsg: 'session ended' },
  });

  await runHookReport('claude', {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-2', source: 'clear' }),
      ),
    exit: () => {},
  });

  await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-2' },
  });

  const record = await ctx.daemon.client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    session: { alive: false, state: 'exited', lastMsg: 'session ended', agentSessionID: 'fake-2' },
  });
});

test('it keeps a grok session needing you when an idle notification follows a permission prompt', async () => {
  const ctx = await setupTest();

  const db = new Database(ctx.daemon.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const ok = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.daemon.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  updateEnv('ATC_SESSION_ID', id);
  updateEnv('ATC_SOCKET', ctx.daemon.reporterSocketPath);

  await runHookReport('grok', {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          hookEventName: 'notification',
          sessionId: 'fake-grok-1',
          notificationType: 'idle_prompt',
        }),
      ),
    exit: () => {},
  });

  // The daemon records every hook it takes after it has applied it, so a
  // second recorded notification is one the session has already seen.
  await waitFor(() => {
    expect(
      db.query("SELECT event FROM events WHERE atc_id = ? AND event = 'Notification'").values(id),
    ).toHaveLength(2);
  });

  const listed = await ctx.daemon.client.sendRequest('session.list');

  expect(listed).toMatchObject({ sessions: [{ id, state: 'needs_you', agent: 'grok' }] });
});

test('it keeps a nested codex harness from rebinding or answering for the claude session it runs in', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(ctx.daemon.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  // The test runs the session's message tap, as the agent's `atc tap` would.
  void runTap(id, ctx.daemon.build, ctx.daemon.socketPath, {
    writeStdout: () => Promise.resolve(),
    printError: () => {},
    exit: () => {},
  });

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: id,
    text: 'ping from test',
  });

  const messageID = getString(sent, 'message');

  await waitForEvent(ctx.daemon.events, { ev: 'SessionMessage', status: 'delivered' });

  updateEnv('ATC_SESSION_ID', id);
  updateEnv('ATC_SOCKET', ctx.daemon.reporterSocketPath);

  await runHookReport('codex', {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: 'nested-codex-1',
          transcript_path: `${ctx.home}/nested-rollout.jsonl`,
          source: 'startup',
        }),
      ),
    exit: () => {},
  });

  await runHookReport('codex', {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          hook_event_name: 'Stop',
          session_id: 'nested-codex-1',
          last_assistant_message: 'nested codex output',
        }),
      ),
    exit: () => {},
  });

  await waitFor(() => {
    expect(ctx.daemon.logs).toIncludeAllMembers([
      `atc hook event=dropped session=${id} agent=codex hook=SessionStart`,
      `atc hook event=dropped session=${id} agent=codex hook=Stop`,
    ]);
  });

  const record = await ctx.daemon.client.sendRequest('session.get', { session: id });
  const message = await ctx.daemon.client.sendRequest('message.get', { message: messageID });

  expect(record).toMatchObject({
    session: { agentSessionID: 'fake-1', state: 'needs_you', lastMsg: 'needs permission' },
    result: null,
  });

  expect(message).toMatchObject({ session: id, status: 'delivered' });
  expect(message).not.toContainKey('answer');
});

test('it drops a hook line without an agent at a session whose own hooks carry one', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  await waitForEvent(ctx.daemon.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  updateEnv('ATC_SESSION_ID', id);
  updateEnv('ATC_SOCKET', ctx.daemon.reporterSocketPath);

  await runHookReport('', {
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          hook_event_name: 'Stop',
          session_id: 'nested-codex-1',
          last_assistant_message: 'nested codex output',
        }),
      ),
    exit: () => {},
  });

  await waitFor(() => {
    expect(ctx.daemon.logs).toContain(`atc hook event=dropped session=${id} agent= hook=Stop`);
  });

  const record = await ctx.daemon.client.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({
    session: { agentSessionID: 'fake-1', state: 'needs_you' },
    result: null,
  });
});

test.each(['resume', 'clear', 'compact'])(
  'it rebinds a claude session to the agent session its own %s starts',
  async (source) => {
    const ctx = await setupTest();

    const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');

    await waitForEvent(ctx.daemon.events, {
      ev: 'SessionState',
      session: { state: 'needs_you' },
    });

    updateEnv('ATC_SESSION_ID', id);
    updateEnv('ATC_SOCKET', ctx.daemon.reporterSocketPath);

    await runHookReport('claude', {
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-2', source }),
        ),
      exit: () => {},
    });

    const rebound = await waitForEvent(ctx.daemon.events, {
      ev: 'SessionState',
      session: { agentSessionID: 'fake-2' },
    });

    expect(rebound).toMatchObject({ session: { id, agent: 'claude' } });
  },
);

test('it binds a gateway session through the hook command atc wrote for it', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('claude');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    agent: 'zai',
  });

  const id = getString(getRecord(spawned, 'session'), 'id');
  const args = ctx.agents.sessions[0]?.harness.spec.args ?? [];

  const settings: unknown = await Bun.file(args[args.indexOf('--settings') + 1] ?? '').json();

  const command = z.object({ command: z.string() });
  const matcher = z.object({ hooks: z.tuple([command]) });
  const hooks = z.object({ hooks: z.object({ SessionStart: z.tuple([matcher]) }) }).parse(settings);

  const reported = Bun.spawn(['/bin/sh', '-c', hooks.hooks.SessionStart[0].hooks[0].command], {
    env: { ...process.env, ATC_SESSION_ID: id, ATC_SOCKET: ctx.daemon.reporterSocketPath },
    stdin: Buffer.from(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-1' })),
  });

  const bound = await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-1' },
  });

  const exitCode = await reported.exited;

  expect(exitCode).toBe(0);
  expect(bound).toMatchObject({ session: { id, agent: 'zai' } });
});

test('it binds a session from a hook line without an agent while none of its own carried one', async () => {
  const ctx = await setupTest();

  ctx.agents.holdStart('grok');

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
    agent: 'grok',
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  updateEnv('ATC_SESSION_ID', id);
  updateEnv('ATC_SOCKET', ctx.daemon.reporterSocketPath);

  await runHookReport('', {
    readStdin: () =>
      Promise.resolve(JSON.stringify({ hookEventName: 'session_start', sessionId: 'fake-grok-1' })),
    exit: () => {},
  });

  const bound = await waitForEvent(ctx.daemon.events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-grok-1' },
  });

  expect(bound).toMatchObject({ session: { id, agent: 'grok' } });
});
