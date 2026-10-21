import { posix } from 'node:path';
import type { SpawnRequest } from './spawn-request';

// An auto-named spawn in a directory the daemon picked takes that directory's name.
export function pickSpawnName(
  spawn: Pick<SpawnRequest, 'name' | 'namedBy' | 'cwd'>,
  directory: string,
): string {
  return spawn.namedBy === 'auto' && directory !== spawn.cwd
    ? posix.basename(directory)
    : spawn.name;
}
