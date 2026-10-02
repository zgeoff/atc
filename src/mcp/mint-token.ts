import { randomBytes } from 'node:crypto';

/**
 * A fresh opaque token: a fixed prefix that marks its kind, then 32 random
 * bytes in base64url.
 */
export function mintToken(prefix: 'atc_at_' | 'atc_rt_' | 'atc_ac_'): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}
