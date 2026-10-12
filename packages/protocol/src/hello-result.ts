import { z } from 'zod';

/**
 * The `daemon.hello` answer: the daemon's build and stable id, the line
 * and chunk limits it holds a client to, the features it announces, how
 * long it keeps a completed idempotency key, and the agent a spawn without
 * one last used.
 */
export const HELLO_RESULT_SCHEMA = z.object({
  daemon: z.string(),
  daemonID: z.string(),
  limits: z.object({ maxLine: z.number(), maxChunk: z.number() }),
  features: z.array(z.string()).readonly(),
  idempotency: z.object({ completedRetentionMs: z.number() }),
  lastUsedAgent: z.string(),
});

export type HelloResult = z.output<typeof HELLO_RESULT_SCHEMA>;
