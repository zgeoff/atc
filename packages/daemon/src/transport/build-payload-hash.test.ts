import { expect, test } from 'bun:test';
import { buildPayloadHash } from './build-payload-hash';

test('it hashes params to the hash a stored idempotency record holds', () => {
  expect(
    buildPayloadHash({
      name: 'é',
      Zeta: 1,
      alpha: { beta: [{ Yankee: 1, x: 2 }], Alpha: true },
      idempotencyKey: 'k',
    }),
  ).toBe('5b7f09bc878e5ec5b66ea41ac29e6b48df20c16cd5edeab4a23ff613cba87966');
});

test('it hashes the same params alike whatever their key order', () => {
  const first = buildPayloadHash({ cwd: '/tmp', opts: { alpha: 1, beta: [{ y: 2, x: 1 }] } });
  const second = buildPayloadHash({ opts: { beta: [{ x: 1, y: 2 }], alpha: 1 }, cwd: '/tmp' });

  expect(second).toBe(first);
});

test('it leaves the idempotency key out of the hash', () => {
  const keyed = buildPayloadHash({ cwd: '/tmp', idempotencyKey: 'k-1' });
  const bare = buildPayloadHash({ cwd: '/tmp' });

  expect(keyed).toBe(bare);
});

test('it hashes different params differently', () => {
  const first = buildPayloadHash({ cwd: '/tmp' });
  const second = buildPayloadHash({ cwd: '/var' });

  expect(second).not.toBe(first);
});
