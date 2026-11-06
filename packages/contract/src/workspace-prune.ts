import { z } from 'zod';

const STRINGS = z.array(z.string()).readonly();

// A workspace atc created, or a session's state folder on the daemon's host.
const KIND = z.enum(['workspace', 'state']);

// The space the folder takes on disk, or null when its host did not say.
const BYTES = z.number().int().nonnegative().nullable();

// A dry run reports `remove` for each folder a prune with remove would take away, and a prune with
// remove reports it once it is gone. `skip` is a folder under a workspaces root that no store row
// names, which a prune never touches.
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
