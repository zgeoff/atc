import { expect, test } from 'bun:test';
import type { ExecutionProvider } from '@atc/plugin-api';
import { toDaemonID } from '@atcx/contract';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { collectSessionDescriptors } from './collect-session-descriptors';

function setupTest() {
  const session = buildMockSession();

  const collect = (provider: ExecutionProvider | null) =>
    collectSessionDescriptors(
      { sessions: [session], findAdapter: () => null, findProvider: () => provider },
      { daemonID: toDaemonID('d1') },
    );

  return { session, collect };
}

test('it lists no host for a session whose provider reports none', () => {
  const ctx = setupTest();
  const [descriptor] = ctx.collect(buildStubMemoryProvider());

  expect(descriptor).not.toContainKey('host');
});

test('it lists no host for a session with no provider', () => {
  const ctx = setupTest();
  const [descriptor] = ctx.collect(null);

  expect(descriptor).not.toContainKey('host');
});

test('it lists the host fact its provider reports for the session host key', () => {
  const ctx = setupTest();
  const asked: string[] = [];

  const [descriptor] = ctx.collect({
    ...buildStubMemoryProvider(),
    findHostFact: (host) => {
      asked.push(host);

      return { name: 'box-1', id: 'host-9', issuer: 'https://hosts.example.test' };
    },
  });

  expect(descriptor?.host).toStrictEqual({
    name: 'box-1',
    id: 'host-9',
    issuer: 'https://hosts.example.test',
  });

  expect(asked).toStrictEqual([ctx.session.hostKey]);
});
