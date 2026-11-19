import { z } from 'zod';

export const EXECUTION_TARGET_CONFIG_SCHEMA = z.object({
  id: z.string(),
  options: z.record(z.string(), z.unknown()),

  // the daemon's environment, which an option such as a token variable's name
  // selects from.
  env: z.record(z.string(), z.string().optional()),
});

export type ExecutionTargetConfig = z.infer<typeof EXECUTION_TARGET_CONFIG_SCHEMA>;
