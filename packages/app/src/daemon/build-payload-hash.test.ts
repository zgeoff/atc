import { expect, test } from 'bun:test';
import { buildPayloadHash } from './build-payload-hash';

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
