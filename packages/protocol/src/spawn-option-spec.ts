import { z } from 'zod';

// A value worth offering and the provider model it maps to, when the config
// holds that mapping.
const SPAWN_OPTION_EXAMPLE_SCHEMA = z.object({
  value: z.string(),
  resolvesTo: z.string().nullable(),
});

/**
 * Whether an agent's CLI takes one spawn option, and which values it does.
 * `values` holds the closed set a value must come from; null takes any
 * well-formed value. `examples` are values worth offering, with the
 * provider model each maps to when the config holds that mapping.
 * `backendEffect` is `applied` when the CLI applies the value itself and
 * `unverified` when the backend behind the CLI may ignore it; null for an
 * option the agent does not take.
 */
export const SPAWN_OPTION_SPEC_SCHEMA = z.object({
  supported: z.boolean(),
  values: z.array(z.string()).readonly().nullable(),
  examples: z.array(SPAWN_OPTION_EXAMPLE_SCHEMA).readonly(),
  default: z.string().nullable(),
  backendEffect: z.enum(['applied', 'unverified']).nullable(),
  note: z.string().nullable(),
});

export type SpawnOptionSpec = Readonly<z.output<typeof SPAWN_OPTION_SPEC_SCHEMA>>;
