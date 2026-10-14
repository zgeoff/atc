import { z } from 'zod';
import { MESSAGE_STATUS_SCHEMA } from './message-status';

/**
 * The `session.message`, `message.ack`, and `notice.ack` answer: the
 * message's id and its status after the request.
 */
export const MESSAGE_ANSWER_SCHEMA = z.object({
  message: z.string(),
  status: MESSAGE_STATUS_SCHEMA,
});
