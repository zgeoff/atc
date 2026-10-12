import { z } from 'zod';
import { MESSAGE_STATUS_SCHEMA } from './message-status';

/**
 * An inbox message as `message.get` answers it: who sent it to which
 * session, its text, where it stands and when each step happened, the
 * answer, the turn that answered it, and the messages that answer cites.
 */
export const MESSAGE_VIEW_SCHEMA = z.object({
  message: z.string(),
  session: z.string(),
  from: z.string(),
  text: z.string(),
  status: MESSAGE_STATUS_SCHEMA,
  sentAt: z.number(),
  deliveredAt: z.number().optional(),
  answeredAt: z.number().optional(),
  answer: z.string().optional(),
  turn: z.string().nullable(),
  answeredWith: z.array(z.string()).readonly(),
});

export type MessageView = z.output<typeof MESSAGE_VIEW_SCHEMA>;
