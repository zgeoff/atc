import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { createStateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  buildStubClock,
  buildStubLog,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import { createSessionManager } from '../sessions/create-session-manager';
import type { SessionRuntime } from '../sessions/create-session-runtime';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createFleetRestorer } from './create-fleet-restorer';
import type { RestoreSettled } from './restore-fleet';

// A session manager on one `local` target over the in-memory provider, a
// real state store, and the restorer over them. No session holds a
// runtime, so a stagger waits on no boot.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-fleet-restorer-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [buildStubHarnessAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
  });

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const recorder = buildStubLog();

  manager.log = recorder.log;

  // No session gets a runtime.
  const runtimes = new Map<SessionID, SessionRuntime>();

  const onRestoreSettled = mock<(settled: RestoreSettled) => void>();
  const onRestoreSkipped = mock<(reason: 'disabled' | 'empty') => void>();

  const restorer = createFleetRestorer({
    manager,
    store,
    clock: buildStubClock(1_000_000),
    findRuntime: (id) => runtimes.get(id),
    capMs: 30_000,
    isStopped: () => false,
    onRestoreSettled,
    onRestoreSkipped,
  });

  return {
    directory: temporaryDirectory.path,
    store,
    manager,
    lines: recorder.lines,
    onRestoreSettled,
    onRestoreSkipped,
    restorer,
  };
}

test('it registers the stored sessions and reports the restore once it settles', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-1'), cwd: ctx.directory, exited: true }),
    buildMockFleetEntry({ sessionID: toSessionID('s-2'), cwd: ctx.directory, exited: true }),
  ]);

  const restored = await ctx.restorer.runFleetRestore(80, 24);

  expect(restored).toBe(2);
  expect(ctx.manager.sessions.map((session) => session.id)).toIncludeSameMembers(['s-1', 's-2']);

  await waitFor(() => {
    expect(ctx.onRestoreSettled).toHaveBeenCalledExactlyOnceWith({
      restored: 2,
      outcome: 'finished',
    });
  });
});

test('it joins a restore requested while another one runs', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-1'), cwd: ctx.directory, exited: true }),
  ]);

  const first = ctx.restorer.runFleetRestore(80, 24);
  const second = ctx.restorer.runFleetRestore(80, 24);

  expect(second).toBe(first);

  await first;

  expect(ctx.manager.sessions).toHaveLength(1);
});

test('it reports a restore that fails as failed and rejects', async () => {
  const ctx = await setupTest();

  await ctx.store.stop();

  const restored = ctx.restorer.runFleetRestore(80, 24);

  expect(restored).rejects.toThrow();

  await waitFor(() => {
    expect(ctx.onRestoreSettled).toHaveBeenCalledExactlyOnceWith({
      restored: 0,
      outcome: 'failed',
    });
  });
});

test('it skips the boot restore when the option is off', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-1'), cwd: ctx.directory, exited: true }),
  ]);

  await ctx.restorer.startBootRestore(false);

  expect(ctx.onRestoreSkipped).toHaveBeenCalledExactlyOnceWith('disabled');
  expect(ctx.manager.sessions).toBeEmpty();
});

test('it skips the boot restore of an empty stored fleet', async () => {
  const ctx = await setupTest();

  await ctx.restorer.startBootRestore(true);

  expect(ctx.onRestoreSkipped).toHaveBeenCalledExactlyOnceWith('empty');
});

test('it logs a stored fleet it cannot read at boot and resolves', async () => {
  const ctx = await setupTest();

  await ctx.store.stop();
  await ctx.restorer.startBootRestore(true);

  expect(ctx.lines).toSatisfyAny((line: string) =>
    line.startsWith('atc could not restore the fleet ('),
  );

  expect(ctx.onRestoreSkipped).not.toHaveBeenCalled();
  expect(ctx.onRestoreSettled).not.toHaveBeenCalled();
});

test('it restores the stored fleet at boot when the option is on', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-1'), cwd: ctx.directory, exited: true }),
  ]);

  await ctx.restorer.startBootRestore(true);

  await waitFor(() => {
    expect(ctx.onRestoreSettled).toHaveBeenCalledExactlyOnceWith({
      restored: 1,
      outcome: 'finished',
    });
  });

  expect(ctx.onRestoreSkipped).not.toHaveBeenCalled();
});
