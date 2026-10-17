import { z } from 'zod';

export const SESSION_WORKSPACE_SCHEMA = z.object({
  repoURL: z.string(),
  sha: z.string(),
  ref: z.string().optional(),
  materializedAt: z.number(),
});

export type SessionWorkspace = Readonly<z.output<typeof SESSION_WORKSPACE_SCHEMA>>;
