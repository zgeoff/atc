import { z } from 'zod';

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
