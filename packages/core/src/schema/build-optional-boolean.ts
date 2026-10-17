import { z } from 'zod';

// anything else parses to undefined so the caller's default stands, rather
// than failing the whole object.
export function buildOptionalBoolean() {
  return z.preprocess((v) => (typeof v === 'boolean' ? v : undefined), z.boolean().optional());
}
