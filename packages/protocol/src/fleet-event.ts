import { z } from 'zod';

export const FLEET_EVENT_SCHEMA = z.object({
  cursor: z.string(),
  at: z.number(),
  session: z.string(),
  name: z.string().nullable(),
  kind: z.string(),
  detail: z.string().nullable(),
  message: z.string().optional(),
  label: z.string().optional(),
});
