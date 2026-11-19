import { z } from 'zod';
import { buildOptionalBoolean } from '../schema/build-optional-boolean';
import { buildOptionalString } from '../schema/build-optional-string';

// An absent or wrong-typed field parses to undefined instead of failing the whole file,
// so a bad config.json falls back to defaults rather than stopping atc from starting.
export const CONFIG_FILE_SCHEMA = z.object({
  agents: z.unknown().optional(),
  sources: z.unknown().optional(),
  dirs: z.unknown().optional(),
  workspaces: z.unknown().optional(),
  authProfiles: z.unknown().optional(),
  hooks: z.unknown().optional(),
  leader: buildOptionalString(),
  targets: z.unknown().optional(),
  defaultTarget: z.unknown().optional(),
  principals: z.unknown().optional(),
  daemons: z.unknown().optional(),
  restoreFleetOnRestart: buildOptionalBoolean(),
});

export type ConfigFile = z.output<typeof CONFIG_FILE_SCHEMA>;
