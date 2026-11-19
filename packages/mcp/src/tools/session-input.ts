import { z } from 'zod';

// tool schemas require the session; the daemon's wire schemas default an absent
// one to an empty string instead.
export const SESSION_ID_BASE = z.object({
  session: z.string().describe('The atc session id, from atc_sessions_list'),
});

export const SESSION_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  SESSION_ID_BASE.strict(),
);
