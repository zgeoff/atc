import { z } from 'zod';

// One tool a turn used, with its input summarized.
const TRANSCRIPT_TOOL_SCHEMA = z.object({ name: z.string(), input: z.string() });

export const TRANSCRIPT_ROW_SCHEMA = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  tools: z.array(TRANSCRIPT_TOOL_SCHEMA).readonly(),
  at: z.number().nullable(),
});

export type TranscriptRow = Readonly<z.output<typeof TRANSCRIPT_ROW_SCHEMA>>;
