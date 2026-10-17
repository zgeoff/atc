import { z } from 'zod';

// anything else parses to undefined so the caller's default stands, rather
// than failing the whole object.
export function buildOptionalString() {
  return z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().optional());
}
