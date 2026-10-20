import { expect, test } from 'bun:test';
import { buildBindingPayloadHash } from './build-binding-payload-hash';

test('it hashes params to the hash a stored binding holds', () => {
  expect(
    buildBindingPayloadHash({
      name: 'é',
      Zeta: 1,
      alpha: { b: [{ Y: 1, x: 2 }], A: true },
      idempotencyKey: 'k',
    }),
  ).toBe('0209c43032888ea0492c95773ac44684f1edd51e8666bb376e43bc85315bc402');
});

test('it hashes params the same whatever their key order or idempotency key', () => {
  expect(buildBindingPayloadHash({ cwd: '/tmp', name: 'a', idempotencyKey: 'k1' })).toBe(
    buildBindingPayloadHash({ name: 'a', cwd: '/tmp', idempotencyKey: 'k2' }),
  );
});

test('it hashes params with another payload apart', () => {
  expect(buildBindingPayloadHash({ cwd: '/tmp' })).not.toBe(
    buildBindingPayloadHash({ cwd: '/var' }),
  );
});

test('it hashes params the same in either order of two keys a locale comparison ties', () => {
  expect(buildBindingPayloadHash({ café: 1, café: 2 })).toBe(
    buildBindingPayloadHash({ café: 2, café: 1 }),
  );
});

test('it hashes a replay-only resend the same as its first send', () => {
  expect(buildBindingPayloadHash({ cwd: '/tmp', idempotencyKey: 'k', replayOnly: true })).toBe(
    buildBindingPayloadHash({ cwd: '/tmp', idempotencyKey: 'k' }),
  );
});
