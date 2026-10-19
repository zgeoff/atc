import type { SpawnOptionSpec } from '@atc/protocol';

// What a Claude spawn takes as its own plugin folders: any number of paths on
// the daemon's machine, each loaded with --plugin-dir after the ones the
// config sets.
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
