import { z } from 'zod';

/**
 * A list of strings that tolerates anything else in its place. A non-array
 * parses to undefined so the caller's default stands, and a mixed array keeps
 * the strings in it rather than being discarded whole — a config listing one
 * bad argument still contributes its good ones.
 */
export function buildOptionalStringArray() {
  return z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : undefined),
    z.array(z.string()).optional(),
  );
}
