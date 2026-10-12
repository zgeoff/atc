import { z } from 'zod';

/**
 * The traits of one daemon procedure that its callers and the daemon read
 * from the contract. `access` is who may call it: `owner` is the daemon's
 * owner alone, and `principal` is also open to a principal, which runs it
 * through the context scoped to that principal. `readOnly` marks a
 * procedure that only reads, so a caller may send it again after a
 * connection drops. `keyed` marks one the daemon runs at most once under an
 * idempotency key, so a retry under the same key replays its answer.
 */
export const PROCEDURE_META_SCHEMA = z.object({
  access: z.enum(['owner', 'principal']),
  readOnly: z.boolean(),
  keyed: z.boolean(),
});

export type ProcedureMeta = Readonly<z.infer<typeof PROCEDURE_META_SCHEMA>>;
