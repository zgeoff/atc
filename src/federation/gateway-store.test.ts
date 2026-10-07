import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildBindingPayloadHash } from './build-binding-payload-hash';
import { GatewayStore } from './gateway-store';

/**
 * A gateway store on a file in a temp directory. `path` is that file, so a
 * test can open it again the way a restarted gateway does.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-gateway-store-'));
  const path = join(tmp.dir, 'gateway.db');
  const store = GatewayStore.open(path);

  stack.defer(() => {
    store.stop();
  });

  const owned = stack.move();

  return {
    path,
    store,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it keeps the first binding of a key and returns it to a later claim for another daemon', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  const held = ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'pc',
      daemonID: 'd2',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
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
    claimID: 'claim',
    outcome: 'pending',
    outcomeAt: 10,
    sentAt: null,
    effectRef: null,
  });
});

test('it keeps a binding across a gateway restart', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: null,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  ctx.store.stop();

  const restarted = GatewayStore.open(ctx.path);

  onTestFinished(() => {
    restarted.stop();
  });

  expect(restarted.findBinding('c1', 'session.spawn', 'k')).toStrictEqual({
    principal: 'c1',
    operation: 'session.spawn',
    key: 'k',
    daemon: 'cloud',
    daemonID: 'd1',
    retentionMs: null,
    payloadHash: 'h',
    claimID: 'claim',
    outcome: 'pending',
    outcomeAt: 10,
    sentAt: null,
    effectRef: null,
  });
});

test("it holds a key apart from another principal's key", () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: null,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  expect(ctx.store.findBinding('c2', 'session.spawn', 'k')).toBeNull();
});

test("it holds a key apart from another operation's key", () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: null,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  expect(ctx.store.findBinding('c1', 'session.message', 'k')).toBeNull();
});

test('it keeps a completed binding until twice the daemon retention has passed', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    0,
  );

  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 100);

  expect(ctx.store.removeExpiredBindings(2100)).toBe(0);
});

test('it removes a completed binding once twice the daemon retention has passed', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    0,
  );

  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 100);

  const removed = ctx.store.removeExpiredBindings(2101);

  expect(removed).toBe(1);
  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')).toBeNull();
});

test.each([['pending'], ['uncertain']] as const)(
  'it keeps a %s binding however old it is',
  (outcome) => {
    using ctx = setupTest();

    ctx.store.claimBinding(
      {
        principal: 'c1',
        operation: 'session.spawn',
        key: 'k',
        daemon: 'cloud',
        daemonID: 'd1',
        retentionMs: 1000,
        payloadHash: 'h',
        claimID: 'claim',
      },
      0,
    );

    ctx.store.updateOutcome('c1', 'session.spawn', 'k', outcome, 0);

    expect(ctx.store.removeExpiredBindings(Number.MAX_SAFE_INTEGER)).toBe(0);
  },
);

test('it keeps a completed binding to a daemon that announced no retention', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: null,
      payloadHash: 'h',
      claimID: 'claim',
    },
    0,
  );

  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 0);

  expect(ctx.store.removeExpiredBindings(Number.MAX_SAFE_INTEGER)).toBe(0);
});

test('it refuses a key reused with another payload as idempotency_conflict before any daemon call', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: buildBindingPayloadHash({ cwd: '/srv/a', idempotencyKey: 'k' }),
      claimID: 'claim',
    },
    0,
  );

  expect(() =>
    ctx.store.claimBinding(
      {
        principal: 'c1',
        operation: 'session.spawn',
        key: 'k',
        daemon: 'cloud',
        daemonID: 'd1',
        retentionMs: 1000,
        payloadHash: buildBindingPayloadHash({ cwd: '/srv/b', idempotencyKey: 'k' }),
        claimID: 'claim',
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
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: buildBindingPayloadHash({ env: { é: 'precomposed', é: 'decomposed' } }),
      claimID: 'claim',
    },
    0,
  );

  const retried = ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: buildBindingPayloadHash({ env: { é: 'decomposed', é: 'precomposed' } }),
      claimID: 'claim',
    },
    10,
  );

  expect(retried.daemon).toBe('cloud');
});

test('it marks a binding sent for its first send', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  expect(ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 20)).toBeTrue();
});

test('it refuses a second send of a binding already sent', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 20);

  expect(ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 30)).toBeFalse();
});

test('it refuses the first send of a binding sent before a gateway restart', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 20);
  ctx.store.stop();

  const restarted = GatewayStore.open(ctx.path);

  onTestFinished(() => {
    restarted.stop();
  });

  expect(restarted.claimFirstSend('c1', 'session.spawn', 'k', 40)).toBeFalse();
});

test('it keeps the time of the first send when a later send is refused', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 20);
  ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 30);

  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')?.sentAt).toBe(20);
});

test('it keeps a sent binding when its claim is withdrawn', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 20);
  ctx.store.removeBinding('c1', 'session.spawn', 'k', 'claim');

  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')).toStrictEqual({
    principal: 'c1',
    operation: 'session.spawn',
    key: 'k',
    daemon: 'cloud',
    daemonID: 'd1',
    retentionMs: 1000,
    payloadHash: 'h',
    claimID: 'claim',
    outcome: 'pending',
    outcomeAt: 10,
    sentAt: 20,
    effectRef: null,
  });
});

test('it removes an unsent binding when its claim is withdrawn', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  ctx.store.removeBinding('c1', 'session.spawn', 'k', 'claim');

  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')).toBeNull();
});

test('it keeps a completed outcome when a later request under the key goes unanswered', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    {
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      daemonID: 'd1',
      retentionMs: 1000,
      payloadHash: 'h',
      claimID: 'claim',
    },
    10,
  );

  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 20);
  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'uncertain', 30, 'effect');

  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')).toStrictEqual({
    principal: 'c1',
    operation: 'session.spawn',
    key: 'k',
    daemon: 'cloud',
    daemonID: 'd1',
    retentionMs: 1000,
    payloadHash: 'h',
    claimID: 'claim',
    outcome: 'completed',
    outcomeAt: 20,
    sentAt: null,
    effectRef: null,
  });
});
