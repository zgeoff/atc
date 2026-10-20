import { z } from 'zod';

// anything else parses to undefined so the caller's default stands, rather
// than failing the whole object.
export function buildOptionalBoolean() {
  return z.preprocess(
    (value) => (typeof value === 'boolean' ? value : undefined),
    z.boolean().optional(),
  );
}
