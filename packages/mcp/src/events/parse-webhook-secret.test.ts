import { expect, test } from 'bun:test';
import { parseWebhookSecret } from './parse-webhook-secret';

test('it parses a whsec_ secret of 32 bytes to its bytes', () => {
  const bytes = Buffer.alloc(32, 7);

  expect(parseWebhookSecret(`whsec_${bytes.toString('base64')}`)).toStrictEqual(bytes);
});

test.each([
  ['24 bytes, the fewest', 24],
  ['64 bytes, the most', 64],
])('it parses a secret of %s', (_label, length) => {
  expect(parseWebhookSecret(`whsec_${Buffer.alloc(length, 1).toString('base64')}`)).toHaveLength(
    length,
  );
});

test.each([
  ['23 bytes', `whsec_${Buffer.alloc(23, 1).toString('base64')}`],
  ['65 bytes', `whsec_${Buffer.alloc(65, 1).toString('base64')}`],
  ['no whsec_ prefix', Buffer.alloc(32, 1).toString('base64')],
  ['characters outside base64', `whsec_${'*'.repeat(44)}`],
  [
    'base64 cut short of its padding',
    `whsec_${Buffer.alloc(32, 1).toString('base64').slice(0, 43)}`,
  ],
  ['an empty value after the prefix', 'whsec_'],
])('it refuses a secret of %s', (_label, secret) => {
  expect(parseWebhookSecret(secret)).toBeNull();
});
