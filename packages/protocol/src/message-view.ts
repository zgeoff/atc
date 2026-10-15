import { z } from 'zod';
import { MESSAGE_STATUS_SCHEMA } from './message-status';
import { MESSAGE_SENDER_SCHEMA } from './wire/message-sender';

/**
 * An inbox message as `message.get` answers it: who sent it to which
 * session, its text, where it stands and when each step happened, the
 * answer or the reason it went unanswered, the turn that settled it, and the
 * messages that answer cites.
 */
export const MESSAGE_VIEW_SCHEMA = z.object({
  message: z.string(),
  session: z.string(),

  // The sender's name, and who sent it, absent on a message stored before
  // the daemon typed its senders.
  from: z.string(),
  sender: MESSAGE_SENDER_SCHEMA.optional(),
  text: z.string(),
  status: MESSAGE_STATUS_SCHEMA,
  sentAt: z.number(),
  deliveredAt: z.number().optional(),
  answeredAt: z.number().optional(),
  answer: z.string().optional(),
  unansweredAt: z.number().optional(),
  unansweredReason: z.string().optional(),
  turn: z.string().nullable(),
  answeredWith: z.array(z.string()).readonly(),
});

export type MessageView = z.output<typeof MESSAGE_VIEW_SCHEMA>;
