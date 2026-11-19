import { expect, test } from 'bun:test';
import { buildBindingPayloadHash } from './build-binding-payload-hash';

test('it hashes params to the hash a stored binding holds', () => {
  expect(
    buildBindingPayloadHash({
      name: 'é',
      Zeta: 1,
      alpha: { beta: [{ Yankee: 1, x: 2 }], Alpha: true },
      idempotencyKey: 'k',
    }),
  ).toBe('5b7f09bc878e5ec5b66ea41ac29e6b48df20c16cd5edeab4a23ff613cba87966');
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
