import { z } from 'zod';
import { MESSAGE_SENDER_SCHEMA } from '../light/message-sender';
import { MESSAGE_STATUS_SCHEMA } from './message-status-schema';

export const MESSAGE_VIEW_SCHEMA = z.object({
  message: z.string(),
  session: z.string(),

  // Messages already in the store may have no typed sender, so parsing them must accept it missing.
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
