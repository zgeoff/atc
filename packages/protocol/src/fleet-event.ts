import { z } from 'zod';
import { RESTART_RESULT_SCHEMA } from './restart-result';

export const FLEET_EVENT_SCHEMA = z.object({
  cursor: z.string(),
  at: z.number(),
  session: z.string(),
  name: z.string().nullable(),
  kind: z.string(),
  detail: z.string().nullable(),
  message: z.string().optional(),
  label: z.string().optional(),
  result: RESTART_RESULT_SCHEMA.optional(),
});
