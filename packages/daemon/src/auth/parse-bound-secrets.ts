import { z } from 'zod';

// A stored binding's secrets, each read on its own so one that does not read
// leaves the rest.
const BINDING_SECRETS_SCHEMA = z.object({ secrets: z.array(z.unknown()) });
const BOUND_SECRET_SCHEMA = z.object({ secret: z.string() });

export function parseBoundSecrets(json: string): string[] {
  const parsed = BINDING_SECRETS_SCHEMA.safeParse(JSON.parse(json));

  if (!parsed.success) {
    return [];
  }

  return parsed.data.secrets.flatMap((entry) => {
    const bound = BOUND_SECRET_SCHEMA.safeParse(entry);

    return bound.success ? [bound.data.secret] : [];
  });
}
