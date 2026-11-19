import { z } from 'zod';
import { buildBindingHash } from './build-binding-hash';

// A loose object keeps fields this schema does not list. Stripping them would make stored
// secrets that differ only in those fields produce the same binding hash.
const STORED_SECRET_SCHEMA = z.looseObject({ kind: z.string(), rules: z.array(z.unknown()) });

const STORED_BINDING_SCHEMA = z.object({
  secrets: z.array(STORED_SECRET_SCHEMA),
  profileEnv: z.record(z.string(), z.string()).default({}),
  telemetryHost: z.string().nullable().default(null),
});

export function buildStoredBindingHash(bindingJSON: string): string | null {
  const parsed = STORED_BINDING_SCHEMA.safeParse(JSON.parse(bindingJSON));

  return parsed.success ? buildBindingHash(parsed.data) : null;
}
