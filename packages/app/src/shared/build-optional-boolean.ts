import { z } from 'zod';

/**
 * A boolean that tolerates anything else in its place: a non-boolean parses
 * to undefined so the caller's default stands, rather than failing the whole
 * object it belongs to.
 */
export function buildOptionalBoolean() {
  return z.preprocess((v) => (typeof v === 'boolean' ? v : undefined), z.boolean().optional());
}
