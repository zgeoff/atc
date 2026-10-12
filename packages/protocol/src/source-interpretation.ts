import { z } from 'zod';
import { SOURCE_PICK_SCHEMA } from './source-pick';

/**
 * What a spawn source makes of typed text: a scope to browse, a pick, or
 * nothing it recognizes.
 */
export const SOURCE_INTERPRETATION_SCHEMA = z.union([
  z.object({ kind: z.literal('browse'), scope: z.string() }),
  SOURCE_PICK_SCHEMA,
  z.object({ kind: z.literal('none') }),
]);

export type SourceInterpretation = z.output<typeof SOURCE_INTERPRETATION_SCHEMA>;
