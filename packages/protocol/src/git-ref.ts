import { z } from 'zod';

/**
 * One branch or tag `git.probe` found on a remote, with the commit it
 * points at.
 */
export const GIT_REF_SCHEMA = z.object({
  name: z.string(),
  kind: z.enum(['branch', 'tag']),
  sha: z.string(),
});

export type GitRef = z.output<typeof GIT_REF_SCHEMA>;
