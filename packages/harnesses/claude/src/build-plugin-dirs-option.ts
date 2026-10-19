import type { SpawnOptionSpec } from '@atc/protocol';

export function buildPluginDirsOption(): SpawnOptionSpec {
  return {
    supported: true,
    values: null,
    examples: [],
    default: null,
    backendEffect: 'applied',
    note: "Each folder passed as --plugin-dir, after the folders the agent's config sets. An absolute path or one that starts with ~/ on the daemon's machine; a path that does not exist, or a remote target, refuses the spawn.",
  };
}
