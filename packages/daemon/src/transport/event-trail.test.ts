import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { StateStore } from '@atc/store';
import { buildMockFleetEntry, createMigratedStateDB } from '@atc/store/testing';
import {
  buildMockRestartResult,
  buildStubClock,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { TargetAccess } from '../auth/target-access';
import { buildNoteTrailEntry } from '../sessions/build-note-trail-entry';
import { SessionManager } from '../sessions/sessions';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { EventSignal } from './event-signal';
import { EventTrail } from './event-trail';

// A session manager on one `local` target over the in-memory provider, a
// real state store, a stub clock, and the trail over them.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-event-trail-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const manager = new SessionManager(
    null,
    store,
    join(temporaryDirectory.path, 'status.json'),
    [buildStubHarnessAdapter()],
    [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const clock = buildStubClock(1_000_000);

  const eventSignal = new EventSignal(clock);
  const trail = new EventTrail({ manager, store, clock, eventSignal });

  return { dbPath, store, manager, clock, eventSignal, trail };
}

test('it reads the latest events under the session that recorded them', async () => {
  const ctx = await setupTest();

  ctx.manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      name: 'builder',
      target: 'local',
      targetIdentity: 'local-pty:test',
    }),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    1000,
  );

  const page = await ctx.trail.readEvents(null, 10, 0, null, null);

  expect(page).toStrictEqual({
    events: [expect.objectContaining({ session: 's-1', name: 'builder', at: 1000 })],
    more: false,
  });
});

test('it reads the events after a cursor and tells whether more follow', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    1000,
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    2000,
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    3000,
  );

  const page = await ctx.trail.readEvents(0, 2, 0, null, null);

  expect(page.events.map((event) => event.at)).toStrictEqual([1000, 2000]);
  expect(page.more).toBeTrue();
});

test('it holds a read until the trail grows', async () => {
  const ctx = await setupTest();

  const read = ctx.trail.readEvents(0, 10, 60_000, null, null);

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    1000,
  );

  ctx.eventSignal.emit();

  const page = await read;

  expect(page.events).toHaveLength(1);
});

test('it answers an empty page once the wait runs out', async () => {
  const ctx = await setupTest();

  const read = ctx.trail.readEvents(0, 10, 5000, null, null);

  ctx.clock.advance(5000);

  const page = await read;

  expect(page).toStrictEqual({ events: [], more: false });
});

test('it reads none of the events of a session whose target the access may not use', async () => {
  const ctx = await setupTest();

  ctx.manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      target: 'local',
      targetIdentity: 'local-pty:test',
    }),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    1000,
  );

  const page = await ctx.trail.readEvents(
    null,
    10,
    0,
    null,
    new TargetAccess([{ target: 'local', targetIdentity: 'local-pty:other' }]),
  );

  expect(page.events).toBeEmpty();
});

test('it wakes a held read with a restart it records, whole result included', async () => {
  const ctx = await setupTest();

  const result = buildMockRestartResult({ restored: 2, total: 2 });
  const read = ctx.trail.readEvents(0, 10, 60_000, null, null);

  await ctx.trail.recordRestart(result);

  const page = await read;

  expect(page).toStrictEqual({
    events: [
      {
        cursor: expect.toBeString(),
        at: 1_000_000,
        session: '',
        name: null,
        kind: 'daemon-restarted',
        detail: 'restored 2 of 2',
        result,
      },
    ],
    more: false,
  });
});

test('it logs a restart whose trail write fails under its run id and records nothing', async () => {
  const ctx = await setupTest();

  const log = mock();

  ctx.manager.log = log;

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run('DROP TABLE restart_results');

  await ctx.trail.recordRestart(buildMockRestartResult({ runID: 'run-sumac' }));

  const rows = db.query('SELECT kind FROM events').all();

  expect(log).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(
      /^atc daemon\.restarted for restart run run-sumac: the event trail write failed, so a reader that connects later misses it: .*restart_results/u,
    ),
  );

  expect(rows).toStrictEqual([]);
});

test('it reads no restart under an access that reaches every session', async () => {
  const ctx = await setupTest();

  ctx.manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      target: 'local',
      targetIdentity: 'local-pty:test',
    }),
  );

  await ctx.trail.recordRestart(buildMockRestartResult());

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    2_000_000,
  );

  const page = await ctx.trail.readEvents(
    0,
    10,
    0,
    null,
    new TargetAccess([{ target: 'local', targetIdentity: 'local-pty:test' }]),
  );

  expect(page.events.map((event) => event.kind)).toStrictEqual(['turn-done']);
});

test('it reads a note by its trail id with the session that sent it', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry(
    buildNoteTrailEntry(
      toSessionID('s-1'),
      undefined,
      { kind: 'note', label: 'progress', text: 'halfway there' },
      1000,
    ),
  );

  const [row] = await ctx.store.readLatestEvents(1, null);
  const read = await ctx.trail.readNote(row?.id ?? -1, null);

  expect(read).toMatchObject({ owner: 's-1', view: { label: 'progress', text: 'halfway there' } });
});

test('it reads no note under a trail id that holds none', async () => {
  const ctx = await setupTest();
  const read = await ctx.trail.readNote(42, null);

  expect(read).toBeNull();
});

test('it reads no answer under a trail id that holds none', async () => {
  const ctx = await setupTest();
  const read = await ctx.trail.readAnswer(42, null);

  expect(read).toBeNull();
});
