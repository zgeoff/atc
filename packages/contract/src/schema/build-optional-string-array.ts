import { z } from 'zod';

export function buildOptionalStringArray() {
  return z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : undefined,
    z.array(z.string()).optional(),
  );
}
