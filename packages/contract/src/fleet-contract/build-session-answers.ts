import { z } from 'zod';
import { PUBLISHED_RECORD_SCHEMA } from '../sessions/published-record-schema';

const PENDING_PROMPT = z.object({ message: z.string() });

// The answers that carry a session descriptor, built for the descriptor a daemon or the gateway
// sends.
export function buildSessionAnswers<TDescriptor extends z.ZodType>(descriptor: TDescriptor) {
  return {
    spawn: z.object({
      session: descriptor,
      warnings: z.array(z.string()).readonly().optional(),
    }),
    get: z.object({
      session: descriptor,
      prompt: z.string().nullable(),
      lastActivityAt: z.number(),
      pending: PENDING_PROMPT.nullable(),
      result: z.string().nullable(),
      sessionRecord: PUBLISHED_RECORD_SCHEMA.nullable(),
    }),
    list: z.array(descriptor).readonly(),
  };
}
