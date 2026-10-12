import { z } from 'zod';
import { SOURCE_PICK_SCHEMA } from './source-pick';

/**
 * One entry a spawn source lists: its label, an optional second line, and
 * the pick it stands for.
 */
export const SOURCE_CANDIDATE_SCHEMA = z.object({
  label: z.string(),
  detail: z.string().optional(),
  pick: SOURCE_PICK_SCHEMA,
});

export type SourceCandidate = z.output<typeof SOURCE_CANDIDATE_SCHEMA>;
