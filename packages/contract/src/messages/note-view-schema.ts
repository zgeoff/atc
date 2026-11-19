import { z } from 'zod';

export const NOTE_VIEW_SCHEMA = z.object({
  note: z.string(),
  at: z.number(),
  session: z.string(),
  name: z.string().nullable(),
  label: z.string(),
  text: z.string(),
  complete: z.boolean(),
});
