import { expect, mock, test } from 'bun:test';
import { toSessionID } from '@atc/core/to-session-id';
import { buildTargetIdentity } from '@atc/store/build-target-identity';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import { SessionRegistry } from './session-registry';
import { buildStubMemoryProvider } from './testing/build-stub-memory-provider';

test('it resolves an agent id to the registered adapter that declares it', () => {
  const gateway = buildMockAgentAdapter({ id: 'zai' });

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [gateway],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  expect(registry.findAdapter('zai')).toBe(gateway);
});

test('it resolves the fallback adapter by its own id, not by another registered one', () => {
  const fallback = buildMockAgentAdapter();

  const registry = new SessionRegistry({
    fallback,
    adapters: [buildMockAgentAdapter({ id: 'zai' })],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  expect(registry.findAdapter('claude')).toBe(fallback);
});

test('it resolves an agent id no adapter declares to no adapter', () => {
  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [buildMockAgentAdapter({ id: 'zai' })],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  expect(registry.findAdapter('grok')).toBeNull();
});

test('it reports no screen detector when no registered adapter provides one', () => {
  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [buildMockAgentAdapter({ id: 'zai' })],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  expect(registry.hasScreenDetector).toBeFalse();
});

test('it reports a screen detector when a registered adapter provides one', () => {
  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [
      buildMockAgentAdapter({ id: 'zai', screenDetector: { detectAttention: () => null } }),
    ],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  expect(registry.hasScreenDetector).toBeTrue();
});

test('it refuses execution on a target the registry does not hold', () => {
  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  expect(() =>
    registry.requireExecution({ target: 'gone', targetIdentity: null }, 'spawn'),
  ).toThrow(expect.objectContaining({ code: 'unknown_target' }));
});

test('it returns the provider and identity of a usable target', () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider,
      }),
    ],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  expect(
    registry.requireExecution({ target: 'local', targetIdentity: null }, 'spawn'),
  ).toStrictEqual({ provider, identity: buildTargetIdentity('local-pty', {}) });
});

test('it drops a removed session from the list', () => {
  const kept = buildMockSession();
  const dropped = buildMockSession();

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  registry.sessions.push(kept, dropped);
  registry.remove(dropped);

  expect(registry.sessions).toStrictEqual([kept]);
});

test('it marks a removed session for deletion at the next fleet write', () => {
  const session = buildMockSession({ id: toSessionID('s-1') });

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  registry.sessions.push(session);
  registry.remove(session);

  expect([...registry.removedIDs]).toStrictEqual([toSessionID('s-1')]);
});

test('it clears the focus when the removed session held it', () => {
  const session = buildMockSession();

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  registry.sessions.push(session);

  registry.focusedId = session.id;

  registry.remove(session);

  expect(registry.focusedId).toBeNull();
});

test('it keeps the focus when another session is removed', () => {
  const focused = buildMockSession();
  const dropped = buildMockSession();

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  registry.sessions.push(focused, dropped);

  registry.focusedId = focused.id;

  registry.remove(dropped);

  expect(registry.focusedId).toBe(focused.id);
});

test('it raises a removed event for a removed session', () => {
  const session = buildMockSession();
  const onEvent = mock<() => void>();

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent },
  });

  registry.sessions.push(session);
  registry.remove(session);

  expect(onEvent).toHaveBeenCalledExactlyOnceWith('removed', session);
});

test('it counts the caller itself as in its own tree', () => {
  const caller = buildMockSession();

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  registry.sessions.push(caller);

  expect(registry.isCallerTree(caller.id, caller.id)).toBeTrue();
});

test('it counts a session the caller sits under as in its tree', () => {
  const parent = buildMockSession();
  const caller = buildMockSession({ parent: parent.id });

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  registry.sessions.push(parent, caller);

  expect(registry.isCallerTree(parent.id, caller.id)).toBeTrue();
});

test('it leaves a sub-session of the caller out of its tree', () => {
  const caller = buildMockSession();
  const child = buildMockSession({ parent: caller.id });

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  registry.sessions.push(caller, child);

  expect(registry.isCallerTree(child.id, caller.id)).toBeFalse();
});

test('it leaves an unrelated session out of the caller tree', () => {
  const caller = buildMockSession();
  const other = buildMockSession();

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  registry.sessions.push(caller, other);

  expect(registry.isCallerTree(other.id, caller.id)).toBeFalse();
});

test('it collects the sub-sessions of a session in list order', () => {
  const parent = buildMockSession();
  const first = buildMockSession({ parent: parent.id });
  const unrelated = buildMockSession();
  const second = buildMockSession({ parent: parent.id });

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  registry.sessions.push(parent, first, unrelated, second);

  expect(registry.collectChildren(parent.id)).toStrictEqual([first, second]);
});
