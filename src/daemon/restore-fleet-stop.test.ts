import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import type { SessionID } from '../shared/session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { restoreFleet } from './restore-fleet';
import type { SessionRuntime } from './session-runtime';
import type { Session } from './sessions';
import { SessionManager } from './sessions';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-restore-stop-'));

  const store = await StateStore.open(join(tmp.dir, 'state.db'));

  stack.defer(() => store.stop());

  const mgr = new SessionManager(buildMockAgentAdapter(), store, join(tmp.dir, 'status.json'));

  stack.defer(() => {
    mgr.detachAll();
  });

  await store.writeFleet(
    ['s-a', 's-b', 's-c'].map((id) =>
      buildMockFleetEntry({ sessionID: toSessionID(id), cwd: tmp.dir }),
    ),
  );

  const moved = stack.move();

  // No session holds a runtime, so the stagger waits on no boot.
  const runtimes = new Map<SessionID, SessionRuntime>();

  return {
    store,
    mgr,
    findRuntime: (sessionID: SessionID) => runtimes.get(sessionID),
    [Symbol.asyncDispose]: () => moved.disposeAsync(),
  };
}

test('it starts no terminal once the daemon stopped before the restore began', async () => {
  await using ctx = await setupTest();

  const adopt = spyOn(ctx.mgr, 'adoptTerminal');

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
    adopts: adopt.mock.calls.length,
  }).toStrictEqual({ restored: 3, outcome: 'stopped', adopts: 0 });
});

test('it starts no later terminal once the daemon stops while the first one starts', async () => {
  await using ctx = await setupTest();

  let stopped = false;
  const held = Promise.withResolvers<Session | null>();
  const adopt = spyOn(ctx.mgr, 'adoptTerminal').mockImplementation(() => held.promise);

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
    expect(adopt).toHaveBeenCalledOnce();
  });

  stopped = true;

  held.resolve(null);

  const result = await restoring;

  expect({ outcome: await result.settled, adopts: adopt.mock.calls.length }).toStrictEqual({
    outcome: 'stopped',
    adopts: 1,
  });
});

test('it reports a stop once the daemon stops while the last queued terminal starts', async () => {
  await using ctx = await setupTest();

  let stopped = false;
  const held = Promise.withResolvers<Session | null>();

  // The first two terminals are refused at once, so the stagger moves
  // straight to the last, which holds.
  const adopt = spyOn(ctx.mgr, 'adoptTerminal')
    .mockImplementationOnce(() => Promise.resolve(null))
    .mockImplementationOnce(() => Promise.resolve(null))
    .mockImplementationOnce(() => held.promise);

  const result = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
    isStopped: () => stopped,
  });

  await waitFor(() => {
    expect(adopt).toHaveBeenCalledTimes(3);
  });

  stopped = true;

  held.resolve(null);

  expect({ outcome: await result.settled, adopts: adopt.mock.calls.length }).toStrictEqual({
    outcome: 'stopped',
    adopts: 3,
  });
});

test('it tells a starting terminal to give up once the daemon stops', async () => {
  await using ctx = await setupTest();

  let stopped = false;
  const held = Promise.withResolvers<Session | null>();
  const adopt = spyOn(ctx.mgr, 'adoptTerminal').mockImplementation(() => held.promise);

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
    expect(adopt).toHaveBeenCalledOnce();
  });

  const canProceed = adopt.mock.calls[0]?.[3];

  stopped = true;

  const proceeds = canProceed?.();

  held.resolve(null);

  await restoring;

  expect(proceeds).toBeFalse();
});
