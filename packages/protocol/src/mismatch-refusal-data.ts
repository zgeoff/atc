import { z } from 'zod';

// Released daemons refuse with no data, so every field is optional.
export const MISMATCH_REFUSAL_DATA_SCHEMA = z.object({
  daemonProtocol: z.number().int().optional(),
});

export type MismatchRefusalData = z.output<typeof MISMATCH_REFUSAL_DATA_SCHEMA>;
