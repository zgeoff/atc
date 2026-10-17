import { createHash, timingSafeEqual } from 'node:crypto';

export function findTokenFingerprint(tokens: readonly string[], presented: string): string | null {
  const digest = createHash('sha256').update(presented).digest();
  let matched: string | null = null;

  // digests compared in constant time against every token, so neither a token's length nor
  // which token a guess came close to shows in the timing
  for (const token of tokens) {
    const candidate = createHash('sha256').update(token).digest();

    if (timingSafeEqual(candidate, digest) && matched === null) {
      matched = candidate.toString('hex');
    }
  }

  return matched;
}
