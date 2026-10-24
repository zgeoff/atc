import { z } from 'zod';
import { buildOptionalBoolean } from './schema/build-optional-boolean';
import { buildOptionalString } from './schema/build-optional-string';

// A user-written config.json's top-level keys. An absent or wrong-typed
// field parses to undefined rather than failing the file, so a bad config
// falls back to a default instead of refusing to start atc.
export const CONFIG_FILE_SCHEMA = z.object({
  agents: z.unknown().optional(),
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
