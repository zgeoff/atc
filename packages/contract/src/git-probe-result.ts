import { z } from 'zod';
import { GIT_REF_SCHEMA } from './git-ref';

export const GIT_PROBE_RESULT_SCHEMA = z.object({
  url: z.string(),
  head: z.string().nullable(),
  refs: z.array(GIT_REF_SCHEMA).readonly(),
  resolved: z.object({ sha: z.string(), branch: z.string().nullable() }).nullable(),
});

export type GitProbeResult = z.output<typeof GIT_PROBE_RESULT_SCHEMA>;
