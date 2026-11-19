import { z } from 'zod';

const STRINGS = z.array(z.string()).readonly();
const KIND = z.enum(['workspace', 'state']);
const BYTES = z.number().int().nonnegative().nullable();

const PRUNE_FOLDER_SCHEMA = z.discriminatedUnion('verdict', [
  z.object({
    verdict: z.literal('remove'),
    kind: KIND,
    path: z.string(),
    bytes: BYTES,
    found: STRINGS,
  }),
  z.object({
    verdict: z.literal('keep'),
    kind: KIND,
    path: z.string(),
    bytes: BYTES,
    reasons: STRINGS,
  }),
  z.object({
    verdict: z.literal('skip'),
    kind: z.literal('workspace'),
    path: z.string(),
    reason: z.string(),
  }),
]);

export const WORKSPACE_PRUNE_SCHEMA = z.object({
  dryRun: z.boolean(),
  folders: z.array(PRUNE_FOLDER_SCHEMA).readonly(),
});

export type WorkspacePruneFolder = Readonly<z.output<typeof PRUNE_FOLDER_SCHEMA>>;

export type WorkspacePrune = Readonly<z.output<typeof WORKSPACE_PRUNE_SCHEMA>>;
