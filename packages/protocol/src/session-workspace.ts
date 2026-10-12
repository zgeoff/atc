import { z } from 'zod';

/**
 * What a session's ready workspace was built from: the token-free
 * repository URL, the commit checked out, the branch or tag it came from,
 * and when it became ready.
 */
export const SESSION_WORKSPACE_SCHEMA = z.object({
  repoURL: z.string(),
  sha: z.string(),
  ref: z.string().optional(),
  materializedAt: z.number(),
});

export type SessionWorkspace = Readonly<z.output<typeof SESSION_WORKSPACE_SCHEMA>>;
