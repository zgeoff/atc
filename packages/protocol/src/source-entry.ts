import { z } from 'zod';

/**
 * A spawn picker source the daemon offers, as `agents.list` lists it: its
 * id, the label the picker shows, and whether it yields a directory or a
 * git URL.
 */
export const SOURCE_ENTRY_SCHEMA = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['path', 'git']),
});

export type SourceEntry = z.output<typeof SOURCE_ENTRY_SCHEMA>;
