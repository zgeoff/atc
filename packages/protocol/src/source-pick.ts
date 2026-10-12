import { z } from 'zod';

/**
 * What a spawn source resolves a choice to: a directory on the daemon's
 * host, or a git repository URL.
 */
export const SOURCE_PICK_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), dir: z.string() }),
  z.object({ kind: z.literal('git'), url: z.string() }),
]);

export type SourcePick = z.output<typeof SOURCE_PICK_SCHEMA>;
