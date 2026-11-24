import type { z } from 'zod';

// What differs between the gateway's contract and one daemon's: the answers that carry session
// ids, the inputs that name a daemon or a parent, and the procedures only one of them has.
export interface FleetShapes {
  readonly daemonInput: z.ZodRawShape;
  readonly spawnInput: z.ZodRawShape;
  readonly sessionList: z.ZodType;
  readonly spawn: z.ZodType;
  readonly sessionGet: z.ZodType;
  readonly agentsList: z.ZodType;
  readonly eventsPage: z.ZodType;
  readonly extraProcedures: object;
}
