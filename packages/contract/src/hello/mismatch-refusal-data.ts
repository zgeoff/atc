import { z } from 'zod';

// The data of every protocol_mismatch refusal, on the unix socket and over TCP. Both fields are
// optional: a daemon released before the first compatible release sends daemonProtocol alone on
// the unix socket, and no data over TCP.
export const MISMATCH_REFUSAL_DATA_SCHEMA = z.object({
  daemonProtocol: z.number().int().optional(),
  daemonMajor: z.number().int().optional(),
});

export type MismatchRefusalData = z.output<typeof MISMATCH_REFUSAL_DATA_SCHEMA>;
