import { expect, test } from 'bun:test';
import { findTokenFingerprint } from './find-token-fingerprint';

test('it returns the digest of the token a presented token matches', () => {
  const tokens = ['a'.repeat(32), 'b'.repeat(40)];

  // The SHA-256 of the matched token, in hex.
  expect(findTokenFingerprint(tokens, 'b'.repeat(40))).toBe(
    'e26d2da3ab585c9840b157a4a9b5639fda905c2ad33d04d2c598be8883b51236',
  );
});

test('it returns null for a token that matches none', () => {
  expect(findTokenFingerprint(['a'.repeat(32)], 'a'.repeat(31))).toBeNull();
});

test('it returns null when there are no tokens', () => {
  expect(findTokenFingerprint([], 'a'.repeat(32))).toBeNull();
});
