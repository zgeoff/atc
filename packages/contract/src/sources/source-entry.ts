import { z } from 'zod';

export const SOURCE_ENTRY_SCHEMA = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['path', 'git']),
});

export type SourceEntry = z.output<typeof SOURCE_ENTRY_SCHEMA>;
