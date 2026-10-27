import { z } from 'zod';

// What a `session.watch` answers with.
export const WATCH_ANSWER_SCHEMA = z.object({
  cols: z.number(),
  rows: z.number(),
  seq: z.number(),
  replay: z.string(),
});
