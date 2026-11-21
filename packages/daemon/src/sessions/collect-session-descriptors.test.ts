import { expect, test } from 'bun:test';
import type { TargetIdentityRule } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import { toDaemonID } from '@atcx/contract';
import { buildMockSession } from '../test-utils/build-mock-session';
import { buildStubMemoryProvider } from '../test-utils/build-stub-memory-provider';
import { collectSessionDescriptors } from './collect-session-descriptors';

function setupTest() {
  const session = buildMockSession();

  const collect = (provider: ExecutionProvider | null) =>
    collectSessionDescriptors(
      {
        sessions: [session],
        findAdapter: () => null,
        findProvider: () => provider,
        targets: new Map(),
      },
      { daemonID: toDaemonID('d1') },
    );

  const collectPlace = (current: string, saved: string, identityRule?: TargetIdentityRule) =>
    collectSessionDescriptors(
      {
        sessions: [{ ...session, target: 'box', targetIdentity: saved }],
        findAdapter: () => null,
        findProvider: () => null,
        targets: new Map([
          [
            'box',
            {
              id: 'box',
              kind: 'cloud',
              options: {},
              identity: current,
              label: 'box',
              ...(identityRule === undefined ? {} : { identityRule }),
              placeParts: {
                scope: 'shared',
                version: 'place-v1',
                parts: { url: 'https://svc.example.dev' },
              },
              provider: null,
            },
          ],
        ]),
      },
      { daemonID: toDaemonID('d1') },
    )[0]?.place;

  return { session, collect, collectPlace };
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

test('it puts a session on the shared place of a target whose identity it was saved with', () => {
  const ctx = setupTest();

  expect(ctx.collectPlace('cloud:new', 'cloud:new')).toStrictEqual({
    key: expect.stringMatching(/^cloud:place-v1:[\da-f]{16}$/u),
    label: 'box',
  });
});

test('it puts a session with an unconfirmed binding on the shared place of its target', () => {
  const ctx = setupTest();
  const rule = { version: 'v1', ignoredOptions: [] };
  const confirmed = ctx.collectPlace('cloud:fedcba9876543210', 'cloud:fedcba9876543210', rule);

  expect(ctx.collectPlace('cloud:fedcba9876543210', 'cloud:0123456789abcdef', rule)).toStrictEqual(
    confirmed,
  );
});

test('it keeps a session saved on another identity out of the place its target has now', () => {
  const ctx = setupTest();
  const current = ctx.collectPlace('cloud:new', 'cloud:new');
  const changed = ctx.collectPlace('cloud:new', 'cloud:old');

  expect(changed).toStrictEqual({ key: 'daemon:d1:box:cloud:old', label: 'box' });
  expect(changed?.key).not.toBe(current?.key);
});
