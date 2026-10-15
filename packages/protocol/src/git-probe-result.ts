import { z } from 'zod';
import { GIT_REF_SCHEMA } from './git-ref';

/**
 * The `git.probe` answer: the URL probed, the remote's default branch, its
 * branches and tags with their commits, and the commit and branch the
 * requested ref resolves to, null when no ref was asked for.
 */
export const GIT_PROBE_RESULT_SCHEMA = z.object({
  url: z.string(),
  head: z.string().nullable(),
  refs: z.array(GIT_REF_SCHEMA).readonly(),
  resolved: z.object({ sha: z.string(), branch: z.string().nullable() }).nullable(),
});
