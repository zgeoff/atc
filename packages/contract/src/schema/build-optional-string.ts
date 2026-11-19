import { z } from 'zod';

// A plain optional string would make zod reject the whole object on a non-string value;
// mapping it to undefined lets the caller's default apply instead.
export function buildOptionalString() {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value : undefined),
    z.string().optional(),
  );
}
