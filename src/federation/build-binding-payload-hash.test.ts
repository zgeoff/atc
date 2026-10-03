import { expect, test } from 'bun:test';
import { buildBindingPayloadHash } from './build-binding-payload-hash';

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
  expect(buildBindingPayloadHash({ é: 1, é: 2 })).toBe(buildBindingPayloadHash({ é: 2, é: 1 }));
});

test('it hashes a replay-only resend the same as its first send', () => {
  expect(buildBindingPayloadHash({ cwd: '/tmp', idempotencyKey: 'k', replayOnly: true })).toBe(
    buildBindingPayloadHash({ cwd: '/tmp', idempotencyKey: 'k' }),
  );
});
