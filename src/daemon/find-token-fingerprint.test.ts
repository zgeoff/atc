import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { findTokenFingerprint } from './find-token-fingerprint';

test('it returns the digest of the token a presented token matches', () => {
  const tokens = ['a'.repeat(32), 'b'.repeat(40)];

  expect(findTokenFingerprint(tokens, 'b'.repeat(40))).toBe(
    createHash('sha256').update('b'.repeat(40)).digest('hex'),
  );
});

test('it returns null for a token that matches none', () => {
  expect(findTokenFingerprint(['a'.repeat(32)], 'a'.repeat(31))).toBeNull();
});

test('it returns null when there are no tokens', () => {
  expect(findTokenFingerprint([], 'a'.repeat(32))).toBeNull();
});
