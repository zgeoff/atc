import { z } from 'zod';

const RESTART_FAILED_ROW_SCHEMA = z.object({
  name: z.string(),
  id: z.string(),
  reason: z.string(),
});

const RESTART_INTERRUPTED_ROW_SCHEMA = z.object({ name: z.string(), id: z.string() });

export const RESTART_RESULT_SCHEMA = z.object({
  runID: z.string(),
  code: z.number().int(),
  pid: z.number().int().nullable(),
  build: z.string().nullable(),
  listenPort: z.number().int().nullable(),
  restored: z.number().int(),
  total: z.number().int(),
  failed: z.array(RESTART_FAILED_ROW_SCHEMA).readonly(),
  interrupted: z.array(RESTART_INTERRUPTED_ROW_SCHEMA).readonly(),
  error: z.string().nullable(),
});

export type RestartResult = Readonly<z.output<typeof RESTART_RESULT_SCHEMA>>;

export type RestartFailedRow = Readonly<z.output<typeof RESTART_FAILED_ROW_SCHEMA>>;
