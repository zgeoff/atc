import { z } from 'zod';

export const HELLO_RESULT_SCHEMA = z.object({
  daemon: z.string(),
  daemonID: z.string(),
  limits: z.object({ maxLine: z.number(), maxChunk: z.number() }),
  idempotency: z.object({ completedRetentionMs: z.number() }),
  lastUsedAgent: z.string(),
  peerSession: z.string().nullable(),
});

export type HelloResult = z.output<typeof HELLO_RESULT_SCHEMA>;
