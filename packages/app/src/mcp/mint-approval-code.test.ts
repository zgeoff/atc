import { expect, test } from 'bun:test';
import { mintApprovalCode } from './mint-approval-code';

test('it mints 8 characters from the Crockford base32 alphabet', () => {
  expect(mintApprovalCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
});
