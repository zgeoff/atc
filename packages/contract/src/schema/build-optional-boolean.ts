import { z } from 'zod';

// A plain optional boolean would make zod reject the whole object on a non-boolean value;
// mapping it to undefined lets the caller's default apply instead.
export function buildOptionalBoolean() {
  return z.preprocess(
    (value) => (typeof value === 'boolean' ? value : undefined),
    z.boolean().optional(),
  );
}
