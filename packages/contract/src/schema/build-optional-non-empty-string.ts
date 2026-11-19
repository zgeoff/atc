import { z } from 'zod';

// Zod fails the whole object on one bad field, so a non-string or empty value becomes undefined
// and the caller's default applies instead.
export function buildOptionalNonEmptyString() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value !== '' ? value : undefined),
    z.string().optional(),
  );
}
