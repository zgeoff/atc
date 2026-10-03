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
