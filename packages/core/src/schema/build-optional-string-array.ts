import { z } from 'zod';

// a mixed array keeps its strings, so a config listing one bad argument still
// contributes its good ones.
export function buildOptionalStringArray() {
  return z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : undefined),
    z.array(z.string()).optional(),
  );
}
