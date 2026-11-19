import { z } from 'zod';

export const SOURCE_PICK_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), directory: z.string() }),
  z.object({ kind: z.literal('git'), url: z.string() }),
]);

export type SourcePick = z.output<typeof SOURCE_PICK_SCHEMA>;
