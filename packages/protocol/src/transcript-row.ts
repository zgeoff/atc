import { z } from 'zod';

// One tool a turn used, with its input summarized.
const TRANSCRIPT_TOOL_SCHEMA = z.object({ name: z.string(), input: z.string() });

/**
 * One turn of a session's transcript as `session.read` pages it: who spoke,
 * the text, the tools the turn used with their input summarized, and the
 * epoch milliseconds from the line's timestamp, when it has one.
 */
export const TRANSCRIPT_ROW_SCHEMA = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  tools: z.array(TRANSCRIPT_TOOL_SCHEMA).readonly(),
  at: z.number().nullable(),
});

export type TranscriptRow = Readonly<z.output<typeof TRANSCRIPT_ROW_SCHEMA>>;
