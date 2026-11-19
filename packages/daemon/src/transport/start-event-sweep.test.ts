import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createStateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import { toSessionID } from '@atcx/contract';
import { startEventSweep } from './start-event-sweep';

// A real state store, a trail clock on a fixed day, and a sweep clock of
// its own.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-event-sweep-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(Date.parse('2026-03-01T00:00:00.000Z'));
  const sweepClock = buildStubClock(0);

  return { store, clock, sweepClock };
}

test('it removes the trail rows past their age when it starts', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    ctx.clock.now() - 40 * 24 * 60 * 60 * 1000,
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    ctx.clock.now() - 60_000,
  );

  const stop = await startEventSweep({
    store: ctx.store,
    clock: ctx.clock,
    sweepClock: ctx.sweepClock,
  });

  registerTestCleanup(stop);

  const rows = await ctx.store.readLatestEvents(10, null);

  expect(rows).toHaveLength(1);
});

test('it removes the trail rows past their age again once an hour', async () => {
  const ctx = await setupTest();

  const stop = await startEventSweep({
    store: ctx.store,
    clock: ctx.clock,
    sweepClock: ctx.sweepClock,
  });

  registerTestCleanup(stop);

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    ctx.clock.now() - 40 * 24 * 60 * 60 * 1000,
  );

  ctx.sweepClock.advance(60 * 60 * 1000);

  await waitFor(async () => {
    const rows = await ctx.store.readLatestEvents(10, null);

    expect(rows).toBeEmpty();
  });
});

test('it schedules no further sweep once stopped', async () => {
  const ctx = await setupTest();

  const stop = await startEventSweep({
    store: ctx.store,
    clock: ctx.clock,
    sweepClock: ctx.sweepClock,
  });

  stop();

  expect(ctx.sweepClock.collectPending()).toBeEmpty();
});
