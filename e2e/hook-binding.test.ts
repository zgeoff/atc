import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { getRecord, getString, registerTestCleanup, waitFor, waitForEvent } from '@atc/test-utils';
import { startStubAgentDaemon } from '../packages/app/src/test-utils/start-stub-agent-daemon';

// A daemon in the test's process whose agents are the in-process stand-ins,
// which report their hooks over the daemon's real reporter socket.
function setupTest() {
  return startStubAgentDaemon({
    agents: (bins) => ({ claude: { bin: bins.claude }, grok: { bin: bins.grok } }),
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
