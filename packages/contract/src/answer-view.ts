import { z } from 'zod';

export const ANSWER_VIEW_SCHEMA = z.object({
  answer: z.string(),
  at: z.number(),
  session: z.string(),
  name: z.string().nullable(),
  message: z.string(),
  text: z.string(),
  complete: z.boolean(),
});
