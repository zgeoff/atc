import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Checks a PKCE code verifier against the S256 challenge the authorization
 * request carried. Both sides are compared as SHA-256 digests, so the
 * comparison takes the same time whatever the inputs' lengths.
 */
export function verifyPKCE(verifier: string, challenge: string): boolean {
  const derived = createHash('sha256').update(verifier).digest('base64url');
  const left = createHash('sha256').update(derived).digest();
  const right = createHash('sha256').update(challenge).digest();

  return timingSafeEqual(left, right);
}
