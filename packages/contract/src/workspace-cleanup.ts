import { z } from 'zod';

const STRINGS = z.array(z.string()).readonly();

export const WORKSPACE_CLEANUP_SCHEMA = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('removed'), path: z.string(), found: STRINGS }),
  z.object({ outcome: z.literal('kept'), path: z.string(), reasons: STRINGS }),
  z.object({ outcome: z.literal('none') }),
]);

export type WorkspaceCleanup = Readonly<z.output<typeof WORKSPACE_CLEANUP_SCHEMA>>;
