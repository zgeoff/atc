import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { SessionID } from '../shared/session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubHeldProvider } from '../test-utils/build-stub-held-provider';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { buildTargetIdentity } from './build-target-identity';
import { restoreFleet } from './restore-fleet';
import type { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';

/**
 * A session manager whose `local` target prepares each host only once the
 * test releases it, over a real state store. No session holds a runtime,
 * so the stagger waits on no boot.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-restore-stop-');

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  registerTestCleanup(() => store.stop());

  const held = buildStubHeldProvider();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    store,
    join(tmp.dir, 'status.json'),
    [],
    [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: held.provider,
      },
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const runtimes = new Map<SessionID, SessionRuntime>();

  return {
    dir: tmp.dir,
    store,
    mgr,
    held,
    findRuntime: (sessionID: SessionID) => runtimes.get(sessionID),
  };
}

test('it starts no harness once the daemon stopped before the restore began', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-c'), cwd: ctx.dir }),
  ]);

  const result = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    isStopped: () => true,
  });

  const outcome = await result.settled;

  expect(result.restored).toBe(3);
  expect(outcome).toBe('stopped');
  expect(ctx.held.prepares).toStrictEqual([]);
  expect(ctx.held.harnesses).toStrictEqual([]);
});

test('it starts no harness once the daemon stops while the first one starts', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-c'), cwd: ctx.dir }),
  ]);

  let stopped = false;

  const restoring = restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    isStopped: () => stopped,
  });

  await waitFor(() => {
    expect(ctx.held.prepares).toStrictEqual(['s-a']);
  });

  stopped = true;

  ctx.held.release('s-a');

  const result = await restoring;
  const outcome = await result.settled;

  expect(outcome).toBe('stopped');
  expect(ctx.held.prepares).toStrictEqual(['s-a']);
  expect(ctx.held.harnesses).toStrictEqual([]);
});

test('it starts no harness for a queued session once the daemon stops during its start', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: ctx.dir }),
    buildMockFleetEntry({ sessionID: toSessionID('s-c'), cwd: ctx.dir }),
  ]);

  let stopped = false;

  const restoring = restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    isStopped: () => stopped,
  });

  await waitFor(() => {
    expect(ctx.held.prepares).toStrictEqual(['s-a']);
  });

  ctx.held.release('s-a');

  const result = await restoring;

  await waitFor(() => {
    expect(ctx.held.prepares).toStrictEqual(['s-a', 's-b']);
  });

  ctx.held.release('s-b');

  await waitFor(() => {
    expect(ctx.held.prepares).toStrictEqual(['s-a', 's-b', 's-c']);
  });

  stopped = true;

  ctx.held.release('s-c');

  const outcome = await result.settled;

  expect(outcome).toBe('stopped');
  expect(ctx.held.harnesses.map((spec) => spec.session)).toStrictEqual(['s-a', 's-b']);
});
