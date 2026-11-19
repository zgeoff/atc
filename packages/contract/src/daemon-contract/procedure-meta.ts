import { z } from 'zod';

export const PROCEDURE_META_SCHEMA = z.object({
  access: z.enum(['owner', 'principal']),
  readOnly: z.boolean(),
  keyed: z.boolean(),
});

export type ProcedureMeta = Readonly<z.infer<typeof PROCEDURE_META_SCHEMA>>;
