import { z } from 'zod';
import { buildBindingHash } from './build-binding-hash';

// Every field the hash covers is kept as stored, so a form the hash does not
// map to the current one still hashes apart from it.
const STORED_SECRET_SCHEMA = z.looseObject({ kind: z.string(), rules: z.array(z.unknown()) });

const STORED_BINDING_SCHEMA = z.object({
  secrets: z.array(STORED_SECRET_SCHEMA),
  profileEnv: z.record(z.string(), z.string()).default({}),
});

export function buildStoredBindingHash(bindingJSON: string): string | null {
  const parsed = STORED_BINDING_SCHEMA.safeParse(JSON.parse(bindingJSON));

  return parsed.success ? buildBindingHash(parsed.data) : null;
}
