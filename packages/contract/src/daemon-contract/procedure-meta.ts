import { z } from 'zod';

// `principal` also lets a principal call it, through the context scoped to it;
// `readOnly` lets a caller resend it after a connection drops
export const PROCEDURE_META_SCHEMA = z.object({
  access: z.enum(['owner', 'principal']),
  readOnly: z.boolean(),
  keyed: z.boolean(),
});

export type ProcedureMeta = Readonly<z.infer<typeof PROCEDURE_META_SCHEMA>>;
