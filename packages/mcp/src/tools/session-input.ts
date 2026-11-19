import { z } from 'zod';

// The daemon defaults a missing session to an empty string; keep it required here so callers
// must pass one.
export const SESSION_ID_BASE = z.object({
  session: z.string().describe('The atc session id, from atc_sessions_list'),
});

export const SESSION_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  SESSION_ID_BASE.strict(),
);
