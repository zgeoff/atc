import { z } from 'zod';

export const MESSAGE_SENDER_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connector'), client: z.string(), name: z.string() }),
  z.object({ kind: z.literal('session'), session: z.string(), name: z.string() }),
  z.object({ kind: z.literal('local'), name: z.string() }),
  z.object({ kind: z.literal('owner'), name: z.string() }),
]);

export type MessageSender = z.output<typeof MESSAGE_SENDER_SCHEMA>;
