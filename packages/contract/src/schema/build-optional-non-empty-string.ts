import { z } from 'zod';

// anything else parses to undefined so the caller's default stands, rather
// than failing the whole object.
export function buildOptionalNonEmptyString() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value !== '' ? value : undefined),
    z.string().optional(),
  );
}
