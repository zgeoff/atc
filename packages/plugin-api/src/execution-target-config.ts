import { z } from 'zod';

/**
 * The config slice of one execution target: the target's id, the options
 * its entry sets beside its provider, and the daemon's environment, which
 * an option such as a token variable's name selects from.
 */
export const EXECUTION_TARGET_CONFIG_SCHEMA = z.object({
  id: z.string(),
  options: z.record(z.string(), z.unknown()),
  env: z.record(z.string(), z.string().optional()),
});

export type ExecutionTargetConfig = z.infer<typeof EXECUTION_TARGET_CONFIG_SCHEMA>;
