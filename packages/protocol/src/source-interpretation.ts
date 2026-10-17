import { z } from 'zod';
import { SOURCE_PICK_SCHEMA } from './source-pick';

export const SOURCE_INTERPRETATION_SCHEMA = z.union([
  z.object({ kind: z.literal('browse'), scope: z.string() }),
  SOURCE_PICK_SCHEMA,
  z.object({ kind: z.literal('none') }),
]);

export type SourceInterpretation = z.output<typeof SOURCE_INTERPRETATION_SCHEMA>;
