import { z } from 'zod';
import { MESSAGE_STATUS_SCHEMA } from './message-status';
import { MESSAGE_SENDER_SCHEMA } from './wire/message-sender';

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
