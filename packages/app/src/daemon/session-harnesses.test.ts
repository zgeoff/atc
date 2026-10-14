import { expect, mock, test } from 'bun:test';
import { toSessionID } from '@atc/core/to-session-id';
import { buildStubLog } from '@atc/test-utils/build-stub-log';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import { SessionHarnesses } from './session-harnesses';
import { SessionRegistry } from './session-registry';
import { buildStubMemoryProvider } from './testing/build-stub-memory-provider';

// The harness bookkeeping over a real registry whose `local` target runs
// harnesses in memory, with recorders in place of the fleet writer, the
// killer, and the daemon's callbacks.
function setupTest() {
  const provider = buildStubMemoryProvider();
  const recorder = buildStubLog();

  const callbacks = {
    onOutput: mock<() => void>(),
    onEvent: mock<() => void>(),
    onProcessEnded: mock<() => void>(),
    log: recorder.log,
  };

  const registry = new SessionRegistry({
    fallback: null,
    adapters: [],
    targets: [buildMockExecutionTarget({ id: 'local', provider })],
    targetErrors: [],
    callbacks,
  });

  const fleet = { emitChange: mock<() => void>(), tryWriteFleet: mock() };
  const killer = { updateSuspended: mock<() => void>() };

  const harnesses = new SessionHarnesses({ registry, fleet, killer, callbacks });

  return { provider, registry, fleet, killer, callbacks, harnesses, lines: recorder.lines };
}

test('it mints each bridge binding at a fresh epoch with the fields given', () => {
  const ctx = setupTest();

  const first = ctx.harnesses.mintBridgeBinding(
    toSessionID('s-1'),
    'local',
    'local-pty:one',
    toSessionID('s-1'),
  );

  const second = ctx.harnesses.mintBridgeBinding(
    toSessionID('s-2'),
    'imp',
    'imp:two',
    toSessionID('s-1'),
  );

  expect(first).toStrictEqual({
    sessionID: toSessionID('s-1'),
    target: 'local',
    targetIdentity: 'local-pty:one',
    hostKey: toSessionID('s-1'),
    epoch: 1,
  });

  expect(second).toStrictEqual({
    sessionID: toSessionID('s-2'),
    target: 'imp',
    targetIdentity: 'imp:two',
    hostKey: toSessionID('s-1'),
    epoch: 2,
  });
});

test('it counts a host as busy while a launch readies it and idle once the launch settles', async () => {
  const ctx = setupTest();
  const gate = Promise.withResolvers<string>();
  const readying = ctx.harnesses.withHostReadying(toSessionID('h-1'), () => gate.promise);
  const idleWhileReadying = ctx.harnesses.isHostIdle(toSessionID('h-1'), 'local');

  gate.resolve('planned');

  await readying;

  expect(idleWhileReadying).toBeFalse();
  expect(ctx.harnesses.isHostIdle(toSessionID('h-1'), 'local')).toBeTrue();
});

test('it counts a host as busy while a session on it has a harness', () => {
  const ctx = setupTest();

  const session = buildMockSession({
    id: toSessionID('s-1'),
    hostKey: toSessionID('h-1'),
    target: 'local',
    state: 'running',
  });

  session.pty = ctx.provider.spawnHarness({
    session: 's-1',
    host: 'h-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  ctx.registry.sessions.push(session);

  expect(ctx.harnesses.isHostIdle(toSessionID('h-1'), 'local')).toBeFalse();
});

test('it passes the output of an attached harness to the output callback', () => {
  const ctx = setupTest();
  const session = buildMockSession({ id: toSessionID('s-1'), state: 'running' });

  const harness = ctx.provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  session.pty = harness;

  ctx.registry.sessions.push(session);
  ctx.harnesses.attachHarness(session, harness, false);
  ctx.provider.harnesses[0]?.emitData('hello');
  expect(ctx.callbacks.onOutput).toHaveBeenCalledExactlyOnceWith(session, 'hello');
});

test('it marks a session exited and reports its process ended when its harness exits', () => {
  const ctx = setupTest();

  const session = buildMockSession({
    id: toSessionID('s-1'),
    state: 'running',
    kind: 'pty',
  });

  const harness = ctx.provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  session.pty = harness;

  ctx.registry.sessions.push(session);
  ctx.harnesses.attachHarness(session, harness, false);
  ctx.provider.harnesses[0]?.emitExit({ exitCode: 0 });
  expect(session.state).toBe('exited');
  expect(session.lastMsg).toBe('process exited');
  expect(session.pty).toBeNull();
  expect(ctx.callbacks.onProcessEnded).toHaveBeenCalledExactlyOnceWith(session);
});

test('it marks a session asleep and suspended without reporting its process ended when its host sleeps', () => {
  const ctx = setupTest();

  const session = buildMockSession({
    id: toSessionID('s-1'),
    state: 'running',
    kind: 'pty',
  });

  const harness = ctx.provider.spawnHarness({
    session: 's-1',
    host: 's-1',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    cols: 80,
    rows: 24,
  });

  session.pty = harness;

  ctx.registry.sessions.push(session);
  ctx.harnesses.attachHarness(session, harness, true);
  ctx.provider.harnesses[0]?.emitExit({ exitCode: 0, reason: 'suspended' });
  expect(session.vm).toBe('asleep');
  expect(session.suspended).toBeTrue();
  expect(session.lastMsg).toBe('asleep');
  expect(ctx.callbacks.onProcessEnded).not.toHaveBeenCalled();
});

test('it logs and leaves the sessions on a host as they are when putting the host to sleep rejects', async () => {
  const ctx = setupTest();

  const provider = buildStubMemoryProvider({
    capabilities: { suspend: true },
    suspendHost: () => Promise.reject(new Error('host busy')),
  });

  const session = buildMockSession({
    id: toSessionID('s-1'),
    hostKey: toSessionID('h-1'),
    target: 'local',
    state: 'done',
    vm: 'awake',
  });

  ctx.registry.sessions.push(session);

  await expect(ctx.harnesses.trySuspendIdleHost(provider, toSessionID('h-1'), 'local')).toResolve();

  expect(ctx.lines).toStrictEqual([
    'atc could not put the host of session h-1 back to sleep after a refused start (host busy)',
  ]);

  expect(ctx.killer.updateSuspended).not.toHaveBeenCalled();
  expect(session.vm).toBe('awake');
  expect(ctx.fleet.emitChange).not.toHaveBeenCalled();
});

test('it takes a session as auth outdated when its host holds a newer revision', () => {
  const ctx = setupTest();
  const session = buildMockSession({ hostKey: toSessionID('h-1'), authRevision: 1 });

  ctx.harnesses.authRevisions.set(toSessionID('h-1'), 2);

  expect(ctx.harnesses.isAuthOutdated(session)).toBeTrue();
});

test('it takes a session as current when its host holds the revision it launched under', () => {
  const ctx = setupTest();
  const session = buildMockSession({ hostKey: toSessionID('h-1'), authRevision: 2 });

  ctx.harnesses.authRevisions.set(toSessionID('h-1'), 2);

  expect(ctx.harnesses.isAuthOutdated(session)).toBeFalse();
});
