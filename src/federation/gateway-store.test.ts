import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { buildBindingPayloadHash } from './build-binding-payload-hash';
import { GatewayStore } from './gateway-store';

/**
 * A gateway store in a temp directory, reopened by `reopen` on the same
 * file to stand for a gateway restart.
 */
function setupTest() {
  const tmp = setupTempDir('atc-gateway-store-');
  const path = join(tmp.dir, 'gateway.db');
  let store = GatewayStore.open(path);

  return {
    get store() {
      return store;
    },
    reopen(): void {
      store.stop();

      store = GatewayStore.open(path);
    },
    [Symbol.dispose]() {
      store.stop();
      tmp[Symbol.dispose]();
    },
  };
}

test('it keeps the first binding of a key and returns it to a later claim for another daemon', () => {
  using gateway = setupTest();

  gateway.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
    },
    10,
  );

  const held = gateway.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'pc',
      daemonID: 'd2',
      retentionMs: 1000,
      payloadHash: 'h',
    },
    20,
  );

  expect(held).toStrictEqual({
    principal: 'c1',
    operation: 'session.spawn',
    key: 'k',
    daemon: 'cloud',
    daemonID: 'd1',
    retentionMs: 1000,
    payloadHash: 'h',
    outcome: 'pending',
    outcomeAt: 10,
    claimedAt: 10,
    effectRef: null,
  });
});

test('it keeps a binding across a gateway restart', () => {
  using gateway = setupTest();

  gateway.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: null,
      payloadHash: 'h',
    },
    10,
  );

  gateway.reopen();

  expect(gateway.store.findBinding('c1', 'session.spawn', 'k')).toMatchObject({ daemon: 'cloud' });
});

test('it holds the keys of each principal and operation apart', () => {
  using gateway = setupTest();

  gateway.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: null,
      payloadHash: 'h',
    },
    10,
  );

  expect(gateway.store.findBinding('c2', 'session.spawn', 'k')).toBeNull();
  expect(gateway.store.findBinding('c1', 'session.message', 'k')).toBeNull();
});

test('it removes a completed binding once twice the daemon retention has passed', () => {
  using gateway = setupTest();

  gateway.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
    },
    0,
  );

  gateway.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 100);

  expect(gateway.store.removeExpiredBindings(2100)).toBe(0);
  expect(gateway.store.removeExpiredBindings(2101)).toBe(1);
  expect(gateway.store.findBinding('c1', 'session.spawn', 'k')).toBeNull();
});

test.each([['pending'], ['uncertain']] as const)(
  'it keeps a %s binding however old it is',
  (outcome) => {
    using gateway = setupTest();

    gateway.store.claimBinding(
      {
        principal: 'c1',
        operation: 'session.spawn',
        key: 'k',
        daemon: 'cloud',
        daemonID: 'd1',
        retentionMs: 1000,
        payloadHash: 'h',
      },
      0,
    );

    gateway.store.updateOutcome('c1', 'session.spawn', 'k', outcome, 0);

    expect(gateway.store.removeExpiredBindings(Number.MAX_SAFE_INTEGER)).toBe(0);
  },
);

test('it keeps a completed binding to a daemon that announced no retention', () => {
  using gateway = setupTest();

  gateway.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: null,
      payloadHash: 'h',
    },
    0,
  );

  gateway.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 0);

  expect(gateway.store.removeExpiredBindings(Number.MAX_SAFE_INTEGER)).toBe(0);
});

test('it refuses a key reused with another payload as idempotency_conflict before any daemon call', () => {
  using gateway = setupTest();

  gateway.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: buildBindingPayloadHash({ cwd: '/tmp', idempotencyKey: 'k' }),
    },
    0,
  );

  expect(() =>
    gateway.store.claimBinding(
      {
        principal: 'c1',
        operation: 'session.spawn',
        key: 'k',
        daemon: 'cloud',
        daemonID: 'd1',
        retentionMs: 1000,
        payloadHash: buildBindingPayloadHash({ cwd: '/var', idempotencyKey: 'k' }),
      },
      10,
    ),
  ).toThrow(
    expect.objectContaining({
      code: 'idempotency_conflict',
      message: "idempotency key 'k' was first used with a different session.spawn payload",
    }),
  );
});

test('it accepts a retry whose payload holds two keys a locale comparison ties in the other order', () => {
  using gateway = setupTest();

  const binding = {
    principal: 'c1',
    operation: 'session.spawn',
    key: 'k',
    daemon: 'cloud',
    daemonID: 'd1',
    retentionMs: 1000,
  };

  gateway.store.claimBinding(
    {
      ...binding,
      payloadHash: buildBindingPayloadHash({
        env: { é: 'precomposed', é: 'decomposed' },
      }),
    },
    0,
  );

  const retried = gateway.store.claimBinding(
    {
      ...binding,
      payloadHash: buildBindingPayloadHash({
        env: { é: 'decomposed', é: 'precomposed' },
      }),
    },
    10,
  );

  expect(retried.daemon).toBe('cloud');
});
