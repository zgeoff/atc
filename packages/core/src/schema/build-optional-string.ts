import { z } from 'zod';

// anything else parses to undefined so the caller's default stands, rather
// than failing the whole object.
export function buildOptionalString() {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value : undefined),
    z.string().optional(),
  );
}
