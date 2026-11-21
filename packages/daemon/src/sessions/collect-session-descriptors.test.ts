import { expect, mock, test } from 'bun:test';
import { toDaemonID, toSessionID } from '@atcx/contract';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import { buildStubMemoryProvider } from '../test-utils/build-stub-memory-provider';
import { collectSessionDescriptors } from './collect-session-descriptors';
import { createSessionRegistry } from './create-session-registry';
import type { Session } from './session';

function setupTest() {
  const callbacks = { onEvent: mock<() => void>() };
  const store = { daemonID: toDaemonID('d1') };

  const createRegistry = (targets: readonly ExecutionTarget[], sessions: readonly Session[]) => {
    const registry = createSessionRegistry({
      fallback: null,
      adapters: [],
      targets,
      targetErrors: [],
      callbacks,
    });

    registry.sessions.push(...sessions);

    return registry;
  };

  const createAndCollect = (targets: readonly ExecutionTarget[], sessions: readonly Session[]) =>
    collectSessionDescriptors(createRegistry(targets, sessions), store);

  return { createAndCollect };
}

test('it lists no host for a session whose provider reports none', () => {
  const ctx = setupTest();

  const [descriptor] = ctx.createAndCollect(
    [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider(),
      }),
    ],
    [buildMockSession({ target: 'local', targetIdentity: 'local-pty:test' })],
  );

  expect(descriptor).not.toContainKey('host');
});

test('it lists no host for a session with no provider', () => {
  const ctx = setupTest();

  const [descriptor] = ctx.createAndCollect(
    [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider: null })],
    [buildMockSession({ target: 'local', targetIdentity: 'local-pty:test' })],
  );

  expect(descriptor).not.toContainKey('host');
});

test('it lists the host fact its provider reports for the session host key', () => {
  const ctx = setupTest();
  const asked: string[] = [];

  const [descriptor] = ctx.createAndCollect(
    [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: {
          ...buildStubMemoryProvider(),
          findHostFact: (host) => {
            asked.push(host);

            return { name: 'box-1', id: 'host-9', issuer: 'https://hosts.example.test' };
          },
        },
      }),
    ],
    [
      buildMockSession({
        target: 'local',
        targetIdentity: 'local-pty:test',
        hostKey: toSessionID('host-a'),
      }),
    ],
  );

  expect(descriptor?.host).toStrictEqual({
    name: 'box-1',
    id: 'host-9',
    issuer: 'https://hosts.example.test',
  });

  expect(asked).toStrictEqual(['host-a']);
});

test('it puts a session on the shared place of a target whose identity it was saved with', () => {
  const ctx = setupTest();

  const [descriptor] = ctx.createAndCollect(
    [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'cloud',
        identity: 'cloud:new',
        label: 'cloud',
        placeParts: {
          scope: 'shared',
          version: 'place-v1',
          parts: { url: 'https://svc.example.dev' },
        },
        provider: buildStubMemoryProvider({ kind: 'cloud' }),
      }),
    ],
    [buildMockSession({ target: 'box', targetIdentity: 'cloud:new' })],
  );

  expect(descriptor?.place).toStrictEqual({
    key: 'cloud:place-v1:534c6df68a693f9c',
    label: 'cloud',
  });
});

test('it keeps a session saved on another identity out of the place its target has now', () => {
  const ctx = setupTest();

  const [descriptor] = ctx.createAndCollect(
    [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'cloud',
        identity: 'cloud:new',
        label: 'cloud',
        placeParts: {
          scope: 'shared',
          version: 'place-v1',
          parts: { url: 'https://svc.example.dev' },
        },
        provider: buildStubMemoryProvider({ kind: 'cloud' }),
      }),
    ],
    [buildMockSession({ target: 'box', targetIdentity: 'cloud:old' })],
  );

  expect(descriptor?.place).toStrictEqual({ key: 'daemon:d1:box:cloud%3Aold', label: 'cloud' });
});

test('it keeps a session with a binding restore could not confirm out of the place its target has now', () => {
  const ctx = setupTest();

  const [descriptor] = ctx.createAndCollect(
    [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'cloud',
        identity: 'cloud:reach-v1:fedcba9876543210',
        identityRule: { version: 'reach-v1', ignoredOptions: [] },
        label: 'cloud',
        placeParts: {
          scope: 'shared',
          version: 'place-v1',
          parts: { url: 'https://svc.example.dev' },
        },
        provider: buildStubMemoryProvider({ kind: 'cloud' }),
      }),
    ],
    [buildMockSession({ target: 'box', targetIdentity: 'cloud:0123456789abcdef' })],
  );

  expect(descriptor?.place).toStrictEqual({
    key: 'daemon:d1:box:cloud%3A0123456789abcdef',
    label: 'cloud',
  });
});

test('it gives a kept session a key apart from a target whose id holds the saved identity', () => {
  const ctx = setupTest();

  const descriptors = ctx.createAndCollect(
    [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'cloud',
        identity: 'cloud:new',
        provider: buildStubMemoryProvider({ kind: 'cloud' }),
      }),
      buildMockExecutionTarget({
        id: 'box:cloud:old',
        kind: 'cloud',
        identity: 'cloud:other',
        provider: buildStubMemoryProvider({ kind: 'cloud' }),
      }),
    ],
    [
      buildMockSession({ id: toSessionID('kept'), target: 'box', targetIdentity: 'cloud:old' }),
      buildMockSession({
        id: toSessionID('other'),
        target: 'box:cloud:old',
        targetIdentity: 'cloud:other',
      }),
    ],
  );

  expect(descriptors.map((descriptor) => descriptor.place?.key)).toStrictEqual([
    'daemon:d1:box:cloud%3Aold',
    'daemon:d1:box%3Acloud%3Aold',
  ]);
});

test.each([
  [true, 'the spawn made its host', 'host-a', 'cloud:new'],
  [false, 'another session made its host', 'host-b', 'cloud:new'],
  [false, 'its target changed since it was saved', 'host-a', 'cloud:old'],
])(
  'it reports canDestroyHost %p for a session on a destroying provider when %s',
  (expected, _condition, hostKey, savedIdentity) => {
    const ctx = setupTest();

    const [descriptor] = ctx.createAndCollect(
      [
        buildMockExecutionTarget({
          id: 'box',
          kind: 'cloud',
          identity: 'cloud:new',
          provider: buildStubMemoryProvider({ kind: 'cloud', capabilities: { destroy: true } }),
        }),
      ],
      [
        buildMockSession({
          id: toSessionID('host-a'),
          target: 'box',
          targetIdentity: savedIdentity,
          hostKey: toSessionID(hostKey),
        }),
      ],
    );

    expect(descriptor?.canDestroyHost).toBe(expected);
  },
);

test('it reports canDestroyHost false for a session with a binding restore could not confirm', () => {
  const ctx = setupTest();

  const [descriptor] = ctx.createAndCollect(
    [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'cloud',
        identity: 'cloud:reach-v1:fedcba9876543210',
        identityRule: { version: 'reach-v1', ignoredOptions: [] },
        provider: buildStubMemoryProvider({ kind: 'cloud', capabilities: { destroy: true } }),
      }),
    ],
    [
      buildMockSession({
        id: toSessionID('s-1'),
        target: 'box',
        targetIdentity: 'cloud:0123456789abcdef',
        hostKey: toSessionID('s-1'),
      }),
    ],
  );

  expect(descriptor?.canDestroyHost).toBe(false);
});

test('it reports canDestroyHost false for a session on a provider that cannot destroy hosts', () => {
  const ctx = setupTest();

  const [descriptor] = ctx.createAndCollect(
    [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider(),
      }),
    ],
    [
      buildMockSession({
        id: toSessionID('s-1'),
        target: 'local',
        targetIdentity: 'local-pty:test',
        hostKey: toSessionID('s-1'),
      }),
    ],
  );

  expect(descriptor?.canDestroyHost).toBe(false);
});
