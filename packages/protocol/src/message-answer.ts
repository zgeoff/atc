import { z } from 'zod';
import { MESSAGE_STATUS_SCHEMA } from './message-status';

export const MESSAGE_ANSWER_SCHEMA = z.object({
  message: z.string(),
  status: MESSAGE_STATUS_SCHEMA,
});
