import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { SessionID } from '../shared/session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubHeldProvider } from '../test-utils/build-stub-held-provider';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { buildTargetIdentity } from './build-target-identity';
import { restoreFleet } from './restore-fleet';
import type { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';

/**
 * A session manager whose `local` target prepares each host only once the
 * test releases it, over a real state store holding a stored fleet of
 * three sessions, `s-a`, `s-b`, and `s-c`, in that order. No session holds
 * a runtime, so the stagger waits on no boot.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-restore-stop-'));

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  stack.defer(() => store.stop());

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

  stack.defer(() => {
    mgr.detachAll();
  });

  await store.writeFleet(
    ['s-a', 's-b', 's-c'].map((id) =>
      buildMockFleetEntry({ sessionID: toSessionID(id), cwd: tmp.dir }),
    ),
  );

  const runtimes = new Map<SessionID, SessionRuntime>();

  const moved = stack.move();

  return {
    store,
    mgr,
    held,
    findRuntime: (sessionID: SessionID) => runtimes.get(sessionID),
    [Symbol.asyncDispose]: () => moved.disposeAsync(),
  };
}

test('it starts no harness once the daemon stopped before the restore began', async () => {
  await using ctx = await setupTest();

  const result = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    isStopped: () => true,
  });

  expect({
    restored: result.restored,
    outcome: await result.settled,
    prepares: ctx.held.prepares,
    harnesses: ctx.held.harnesses,
  }).toStrictEqual({ restored: 3, outcome: 'stopped', prepares: [], harnesses: [] });
});

test('it starts no harness once the daemon stops while the first one starts', async () => {
  await using ctx = await setupTest();

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

  expect({
    outcome: await result.settled,
    prepares: ctx.held.prepares,
    harnesses: ctx.held.harnesses,
  }).toStrictEqual({ outcome: 'stopped', prepares: ['s-a'], harnesses: [] });
});

test('it starts no harness once the daemon stops while the last queued one starts', async () => {
  await using ctx = await setupTest();

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

  expect({
    outcome: await result.settled,
    harnesses: ctx.held.harnesses.map((spec) => spec.session),
  }).toStrictEqual({ outcome: 'stopped', harnesses: ['s-a', 's-b'] });
});
