import { z } from 'zod';

// a mixed array keeps its strings, so a config listing one bad argument still
// contributes its good ones.
export function buildOptionalStringArray() {
  return z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : undefined,
    z.array(z.string()).optional(),
  );
}
