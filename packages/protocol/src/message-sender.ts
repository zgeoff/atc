import { z } from 'zod';

/**
 * Who sent an inbox message, as the daemon built it from the caller: a
 * connector by the OAuth client id and name the gateway or `atc mcp --http`
 * vouched for, a session by its atc id and the name it had when it sent, or
 * the owner. No caller sets it. Each kind keeps its id under a key of its
 * own, so a reader never takes a client id for a session id.
 */
export const MESSAGE_SENDER_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connector'), client: z.string(), name: z.string() }),
  z.object({ kind: z.literal('session'), session: z.string(), name: z.string() }),
  z.object({ kind: z.literal('owner'), name: z.string() }),
]);

export type MessageSender = z.output<typeof MESSAGE_SENDER_SCHEMA>;
