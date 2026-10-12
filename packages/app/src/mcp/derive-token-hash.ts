import { createHash } from 'node:crypto';

/**
 * The SHA-256 of a token, base64url encoded: the only form of a token the
 * authorization server stores.
 */
export function deriveTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
