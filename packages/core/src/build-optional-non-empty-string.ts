import { z } from 'zod';

/**
 * A non-empty string that tolerates anything else in its place: an empty
 * string or a non-string parses to undefined so the caller's default
 * stands, rather than failing the whole object it belongs to.
 */
export function buildOptionalNonEmptyString() {
  return z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().optional(),
  );
}
