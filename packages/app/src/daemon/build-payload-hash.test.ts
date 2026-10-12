import { expect, test } from 'bun:test';
import { buildPayloadHash } from './build-payload-hash';

test('it hashes params to the hash a stored idempotency record holds', () => {
  expect(
    buildPayloadHash({
      name: 'é',
      Zeta: 1,
      alpha: { b: [{ Y: 1, x: 2 }], A: true },
      idempotencyKey: 'k',
    }),
  ).toBe('0209c43032888ea0492c95773ac44684f1edd51e8666bb376e43bc85315bc402');
});

test('it hashes the same params alike whatever their key order', () => {
  const first = buildPayloadHash({ cwd: '/tmp', opts: { a: 1, b: [{ y: 2, x: 1 }] } });
  const second = buildPayloadHash({ opts: { b: [{ x: 1, y: 2 }], a: 1 }, cwd: '/tmp' });

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
