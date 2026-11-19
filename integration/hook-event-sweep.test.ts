import { expect, test } from 'bun:test';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { getRecord } from '@atc/core/test-utils/get-record';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import type { AdapterEvent } from '@atc/protocol';
import { createStateStore } from '@atc/store';

async function setupTest() {
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
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  const store = await createStateStore(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  return { clock, sweepClock, daemon, sessionID, store };
}

test('it removes expired trail rows when it starts', async () => {
  const ctx = await setupTest();

  await ctx.daemon.sendHookLines(
    { atcId: ctx.sessionID, event: 'SessionStart', payload: { session_id: 'agent-1' } },
    { atcId: ctx.sessionID, event: 'PreToolUse', payload: { session_id: 'agent-1' } },
  );

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(2);
  });

  ctx.clock.advance(40 * 24 * 60 * 60 * 1000);

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    event: 'Stop',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(3);
  });

  await ctx.daemon.restart();

  const rows = await ctx.store.readTrailRows();

  expect(rows.map((row) => ({ at: row.at, kind: row.kind }))).toStrictEqual([
    { at: Date.parse('2026-02-10T00:00:00.000Z'), kind: 'turn-done' },
  ]);
});

test('it removes expired trail rows on the sweep timer', async () => {
  const ctx = await setupTest();

  await ctx.daemon.sendHookLines(
    { atcId: ctx.sessionID, event: 'SessionStart', payload: { session_id: 'agent-1' } },
    { atcId: ctx.sessionID, event: 'PreToolUse', payload: { session_id: 'agent-1' } },
  );

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(2);
  });

  ctx.clock.advance(40 * 24 * 60 * 60 * 1000);

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    event: 'Stop',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(3);
  });

  ctx.sweepClock.advance(60 * 60 * 1000);

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows.map((row) => ({ at: row.at, kind: row.kind }))).toStrictEqual([
      { at: Date.parse('2026-02-10T00:00:00.000Z'), kind: 'turn-done' },
    ]);
  });
});

test('it reads the events a sweep keeps after a cursor from before the sweep', async () => {
  const ctx = await setupTest();

  await ctx.daemon.sendHookLines(
    { atcId: ctx.sessionID, event: 'SessionStart', payload: { session_id: 'agent-1' } },
    { atcId: ctx.sessionID, event: 'Stop', payload: { session_id: 'agent-1' } },
  );

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(2);
  });

  const before = await ctx.daemon.client.sendRequest('events.read', { limit: 1 });

  ctx.clock.advance(40 * 24 * 60 * 60 * 1000);

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    event: 'Stop',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(3);
  });

  ctx.sweepClock.advance(60 * 60 * 1000);

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(1);
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

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(2);
  });

  ctx.clock.advance(24 * 60 * 60 * 1000);

  await ctx.daemon.sendHookLines({
    atcId: ctx.sessionID,
    event: 'PreToolUse',
    payload: { session_id: 'agent-1' },
  });

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(3);
  });

  ctx.clock.advance(40 * 24 * 60 * 60 * 1000);
  ctx.sweepClock.advance(60 * 60 * 1000);

  await waitFor(async () => {
    const rows = await ctx.store.readTrailRows();

    expect(rows).toHaveLength(1);
  });

  const got = await ctx.daemon.client.sendRequest('session.get', { session: ctx.sessionID });

  expect(got['lastActivityAt']).toBe(Date.parse('2026-01-02T00:00:00.000Z'));
});
