// oxlint-disable zgeoff/test-beside-module -- a daemon.ts topic test: the event trail's sweep
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { AdapterEvent } from '@atc/protocol';
import {
  buildMockAgentAdapter,
  buildStubClock,
  getRecord,
  registerTestCleanup,
  waitFor,
} from '@atc/test-utils';
import { startTestDaemon } from '../test-utils/start-test-daemon';

/**
 * A daemon whose trail is stamped from a stepped clock and whose sweep runs
 * on a second one, with one spawned session and a read-only connection to
 * its database. Its hooks read a SessionStart as a start, a Stop as a
 * finished turn, and every other line as a heartbeat.
 */
async function setupTest() {
  // The trail clock starts on a fixed day, so each row's time is exact.
  const clock = buildStubClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const sweepClock = buildStubClock(0);

  const daemon = await startTestDaemon({
    prefix: 'atc-event-sweep-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planHookEvents: (hook) => ({
          events: [
            {
              kind:
                new Map<string, AdapterEvent['kind']>([
                  ['SessionStart', 'started'],
                  ['Stop', 'turn-done'],
                ]).get(hook.event) ?? 'heartbeat',
            },
          ],
        }),
      }),
      clock,
      eventSweepClock: sweepClock,
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  const db = new Database(daemon.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  return { clock, sweepClock, daemon, sessionID, db };
}

test('it removes expired trail rows when it starts', async () => {
  const ctx = await setupTest();

  await ctx.daemon.sendHookLines(
    { atcId: ctx.sessionID, event: 'SessionStart', payload: { session_id: 'agent-1' } },
    { atcId: ctx.sessionID, event: 'PreToolUse', payload: { session_id: 'agent-1' } },
  );

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(2);
  });

  ctx.clock.advance(40 * 24 * 60 * 60 * 1000);

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    event: 'Stop',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(3);
  });

  await ctx.daemon.restart();

  const rows = ctx.db.query('SELECT ts, kind FROM events').all();

  expect(rows).toStrictEqual([{ ts: '2026-02-10T00:00:00.000Z', kind: 'turn-done' }]);
});

test('it removes expired trail rows on the sweep timer', async () => {
  const ctx = await setupTest();

  await ctx.daemon.sendHookLines(
    { atcId: ctx.sessionID, event: 'SessionStart', payload: { session_id: 'agent-1' } },
    { atcId: ctx.sessionID, event: 'PreToolUse', payload: { session_id: 'agent-1' } },
  );

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(2);
  });

  ctx.clock.advance(40 * 24 * 60 * 60 * 1000);

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    event: 'Stop',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(3);
  });

  ctx.sweepClock.advance(60 * 60 * 1000);

  await waitFor(() => {
    const rows = ctx.db.query('SELECT ts, kind FROM events').all();

    expect(rows).toStrictEqual([{ ts: '2026-02-10T00:00:00.000Z', kind: 'turn-done' }]);
  });
});

test('it reads the events a sweep keeps after a cursor from before the sweep', async () => {
  const ctx = await setupTest();

  await ctx.daemon.sendHookLines(
    { atcId: ctx.sessionID, event: 'SessionStart', payload: { session_id: 'agent-1' } },
    { atcId: ctx.sessionID, event: 'Stop', payload: { session_id: 'agent-1' } },
  );

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(2);
  });

  const before = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  ctx.clock.advance(40 * 24 * 60 * 60 * 1000);

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    event: 'Stop',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(3);
  });

  ctx.sweepClock.advance(60 * 60 * 1000);

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(1);
  });

  const after = await ctx.daemon.client.sendRequest('events.read', { cursor: before['cursor'] });

  expect(after).toMatchObject({
    events: [{ kind: 'turn-done', at: Date.parse('2026-02-10T00:00:00.000Z') }],
    more: false,
  });
});

test("it answers session.get with the session's last activity time after a sweep", async () => {
  const ctx = await setupTest();

  await ctx.daemon.sendHookLines(
    { atcId: ctx.sessionID, event: 'SessionStart', payload: { session_id: 'agent-1' } },
    { atcId: ctx.sessionID, event: 'Stop', payload: { session_id: 'agent-1' } },
  );

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(2);
  });

  ctx.clock.advance(24 * 60 * 60 * 1000);

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    event: 'PreToolUse',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(3);
  });

  ctx.clock.advance(40 * 24 * 60 * 60 * 1000);
  ctx.sweepClock.advance(60 * 60 * 1000);

  await waitFor(() => {
    expect(ctx.db.query('SELECT id FROM events').all()).toHaveLength(1);
  });

  const got = await ctx.daemon.client.sendRequest('session.get', { session: ctx.sessionID });

  expect(got['lastActivityAt']).toBe(Date.parse('2026-01-02T00:00:00.000Z'));
});
