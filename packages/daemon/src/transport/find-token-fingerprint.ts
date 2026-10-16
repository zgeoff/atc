import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The fingerprint of the token the presented bearer token matches, or null
 * when it matches none. The comparison runs on SHA-256 digests in constant
 * time against every token, so neither a token's length nor which token a
 * guess came close to shows in the timing. The fingerprint is the matched
 * token's digest in hex, which identifies the token without holding it.
 */
export function findTokenFingerprint(tokens: readonly string[], presented: string): string | null {
  const digest = createHash('sha256').update(presented).digest();
  let matched: string | null = null;

  for (const token of tokens) {
    const candidate = createHash('sha256').update(token).digest();

    if (timingSafeEqual(candidate, digest) && matched === null) {
      matched = candidate.toString('hex');
    }
  }

  return matched;
}
