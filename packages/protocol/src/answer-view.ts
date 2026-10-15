import { z } from 'zod';

/**
 * A message answer as `answer.get` returns it: the cursor of its
 * message-answered event, when the message was answered, the session that
 * answered it and that session's name then, the message id, the answer
 * text, and whether that text is whole or only its preview.
 */
export const ANSWER_VIEW_SCHEMA = z.object({
  answer: z.string(),
  at: z.number(),
  session: z.string(),
  name: z.string().nullable(),
  message: z.string(),
  text: z.string(),
  complete: z.boolean(),
});
