import { z } from 'zod';

// A value worth offering and the provider model it maps to, when the config
// holds that mapping.
const SPAWN_OPTION_EXAMPLE_SCHEMA = z.object({
  value: z.string(),
  resolvesTo: z.string().nullable(),
});

// null `values` takes any well-formed value; `backendEffect` is
// `unverified` when the backend behind the CLI may ignore the value
export const SPAWN_OPTION_SPEC_SCHEMA = z.object({
  supported: z.boolean(),
  values: z.array(z.string()).readonly().nullable(),
  examples: z.array(SPAWN_OPTION_EXAMPLE_SCHEMA).readonly(),
  default: z.string().nullable(),
  backendEffect: z.enum(['applied', 'unverified']).nullable(),
  note: z.string().nullable(),
});

export type SpawnOptionSpec = Readonly<z.output<typeof SPAWN_OPTION_SPEC_SCHEMA>>;
