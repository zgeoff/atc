import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { buildMockKeyBindingClaim } from '../test-utils/build-mock-key-binding-claim';
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

test('#claimBinding keeps the first binding of a key and returns it to a later claim for another daemon', () => {
  using ctx = setupTest();

  const first = buildMockKeyBindingClaim({
    principal: 'c1',
    operation: 'session.spawn',
    key: 'k',
    daemon: 'cloud',
    payloadHash: 'h',
  });

  ctx.store.claimBinding(first, 10);

  const held = ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'pc',
      payloadHash: 'h',
    }),
    20,
  );

  expect(held).toStrictEqual({
    ...first,
    outcome: 'pending',
    outcomeAt: 10,
    sentAt: null,
    effectRef: null,
  });
});

test('#claimBinding refuses a key reused with another payload as idempotency_conflict before any daemon call', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      payloadHash: buildBindingPayloadHash({ cwd: '/srv/a', idempotencyKey: 'k' }),
    }),
    0,
  );

  expect(() =>
    ctx.store.claimBinding(
      buildMockKeyBindingClaim({
        principal: 'c1',
        operation: 'session.spawn',
        key: 'k',
        payloadHash: buildBindingPayloadHash({ cwd: '/srv/b', idempotencyKey: 'k' }),
      }),
      10,
    ),
  ).toThrow(
    expect.objectContaining({
      code: 'idempotency_conflict',
      message: "idempotency key 'k' was first used with a different session.spawn payload",
    }),
  );
});

test('#claimBinding accepts a retry whose payload holds two keys a locale comparison ties in the other order', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'cloud',
      payloadHash: buildBindingPayloadHash({ env: { é: 'precomposed', é: 'decomposed' } }),
    }),
    0,
  );

  const retried = ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      daemon: 'pc',
      payloadHash: buildBindingPayloadHash({ env: { é: 'decomposed', é: 'precomposed' } }),
    }),
    10,
  );

  expect(retried.daemon).toBe('cloud');
});

test('#open keeps a binding across a gateway restart', () => {
  using ctx = setupTest();

  const claim = buildMockKeyBindingClaim({ principal: 'c1', operation: 'session.spawn', key: 'k' });

  ctx.store.claimBinding(claim, 10);
  ctx.store.stop();

  const restarted = GatewayStore.open(ctx.path);

  onTestFinished(() => {
    restarted.stop();
  });

  expect(restarted.findBinding('c1', 'session.spawn', 'k')).toStrictEqual({
    ...claim,
    outcome: 'pending',
    outcomeAt: 10,
    sentAt: null,
    effectRef: null,
  });
});

test("#findBinding holds a key apart from another principal's key", () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({ principal: 'c1', operation: 'session.spawn', key: 'k' }),
    10,
  );

  expect(ctx.store.findBinding('c2', 'session.spawn', 'k')).toBeNull();
});

test("#findBinding holds a key apart from another operation's key", () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({ principal: 'c1', operation: 'session.spawn', key: 'k' }),
    10,
  );

  expect(ctx.store.findBinding('c1', 'session.message', 'k')).toBeNull();
});

test('#removeExpiredBindings keeps a completed binding until twice the daemon retention has passed', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      retentionMs: 1000,
    }),
    0,
  );

  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 100);

  expect(ctx.store.removeExpiredBindings(2100)).toBe(0);
});

test('#removeExpiredBindings removes a completed binding once twice the daemon retention has passed', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      retentionMs: 1000,
    }),
    0,
  );

  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 100);

  const removed = ctx.store.removeExpiredBindings(2101);

  expect(removed).toBe(1);
  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')).toBeNull();
});

test.each([['pending'], ['uncertain']] as const)(
  '#removeExpiredBindings keeps a %s binding however old it is',
  (outcome) => {
    using ctx = setupTest();

    ctx.store.claimBinding(
      buildMockKeyBindingClaim({
        principal: 'c1',
        operation: 'session.spawn',
        key: 'k',
        retentionMs: 1000,
      }),
      0,
    );

    ctx.store.updateOutcome('c1', 'session.spawn', 'k', outcome, 0);

    expect(ctx.store.removeExpiredBindings(Number.MAX_SAFE_INTEGER)).toBe(0);
  },
);

test('#removeExpiredBindings keeps a completed binding to a daemon that announced no retention', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      retentionMs: null,
    }),
    0,
  );

  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 0);

  expect(ctx.store.removeExpiredBindings(Number.MAX_SAFE_INTEGER)).toBe(0);
});

test('#claimFirstSend marks a binding sent for its first send', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({ principal: 'c1', operation: 'session.spawn', key: 'k' }),
    10,
  );

  expect(ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 20)).toBeTrue();
});

test('#claimFirstSend refuses a second send of a binding already sent', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({ principal: 'c1', operation: 'session.spawn', key: 'k' }),
    10,
  );

  ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 20);

  expect(ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 30)).toBeFalse();
});

test('#claimFirstSend refuses the first send of a binding sent before a gateway restart', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({ principal: 'c1', operation: 'session.spawn', key: 'k' }),
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

test('#claimFirstSend keeps the time of the first send when a later send is refused', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({ principal: 'c1', operation: 'session.spawn', key: 'k' }),
    10,
  );

  ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 20);
  ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 30);

  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')?.sentAt).toBe(20);
});

test('#removeBinding keeps a sent binding when its claim is withdrawn', () => {
  using ctx = setupTest();

  const claim = buildMockKeyBindingClaim({
    principal: 'c1',
    operation: 'session.spawn',
    key: 'k',
    claimID: 'claim',
  });

  ctx.store.claimBinding(claim, 10);
  ctx.store.claimFirstSend('c1', 'session.spawn', 'k', 20);
  ctx.store.removeBinding('c1', 'session.spawn', 'k', 'claim');

  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')).toStrictEqual({
    ...claim,
    outcome: 'pending',
    outcomeAt: 10,
    sentAt: 20,
    effectRef: null,
  });
});

test('#removeBinding removes an unsent binding when its claim is withdrawn', () => {
  using ctx = setupTest();

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'c1',
      operation: 'session.spawn',
      key: 'k',
      claimID: 'claim',
    }),
    10,
  );

  ctx.store.removeBinding('c1', 'session.spawn', 'k', 'claim');

  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')).toBeNull();
});

test('#updateOutcome keeps a completed outcome when a later request under the key goes unanswered', () => {
  using ctx = setupTest();

  const claim = buildMockKeyBindingClaim({ principal: 'c1', operation: 'session.spawn', key: 'k' });

  ctx.store.claimBinding(claim, 10);
  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'completed', 20);
  ctx.store.updateOutcome('c1', 'session.spawn', 'k', 'uncertain', 30, 'effect');

  expect(ctx.store.findBinding('c1', 'session.spawn', 'k')).toStrictEqual({
    ...claim,
    outcome: 'completed',
    outcomeAt: 20,
    sentAt: null,
    effectRef: null,
  });
});
