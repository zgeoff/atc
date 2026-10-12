import { expect, test } from 'bun:test';
import { deriveTokenHash } from './derive-token-hash';

test('it hashes a token to its base64url SHA-256', () => {
  expect(deriveTokenHash('atc_at_example')).toBe('zlfehAYBuNPv9DTC2--lQtDScKyn7phb_XT9JcZLYXs');
});
