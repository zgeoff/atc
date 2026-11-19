import { z } from 'zod';

const SPAWN_OPTION_EXAMPLE_SCHEMA = z.object({
  value: z.string(),
  resolvesTo: z.string().nullable(),
});

export const SPAWN_OPTION_SPEC_SCHEMA = z.object({
  supported: z.boolean(),
  values: z.array(z.string()).readonly().nullable(),
  examples: z.array(SPAWN_OPTION_EXAMPLE_SCHEMA).readonly(),
  default: z.string().nullable(),
  backendEffect: z.enum(['applied', 'unverified']).nullable(),
  note: z.string().nullable(),
});

export type SpawnOptionSpec = Readonly<z.output<typeof SPAWN_OPTION_SPEC_SCHEMA>>;
