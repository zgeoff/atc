import { randomInt } from 'node:crypto';

// Crockford base32: no I, L, O, or U, so a code read off a terminal is never
// ambiguous.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A fresh 8-character approval code in Crockford base32, which the operator
 * reads off the terminal and types into the approval page.
 */
export function mintApprovalCode(): string {
  return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}
