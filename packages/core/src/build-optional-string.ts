import { z } from 'zod';

/**
 * A string that tolerates anything else in its place: a non-string parses to
 * undefined so the caller's default stands, rather than failing the whole
 * object it belongs to.
 */
export function buildOptionalString() {
  return z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().optional());
}
