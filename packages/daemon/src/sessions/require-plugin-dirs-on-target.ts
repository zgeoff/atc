import { statSync } from 'node:fs';
import { DaemonError } from '@atc/protocol/wire';

// A remote target's folders are out of the daemon's sight, so any folder
// there refuses the launch, as does a path that is not a folder the daemon
// can read.
export function requirePluginDirsOnTarget(
  dirs: readonly string[],
  target: string,
  remote: boolean,
): void {
  if (dirs.length === 0) {
    return;
  }

  if (remote) {
    throw new DaemonError(
      'unsupported',
      `target '${target}' runs the agent on another machine, so it takes no pluginDirs; the agent's config or the spawn sets them`,
    );
  }

  for (const directory of dirs) {
    const kind = readPathKind(directory);

    if (kind === 'missing') {
      throw new DaemonError('bad_args', `plugin folder '${directory}' does not exist`);
    }

    if (kind === 'other') {
      throw new DaemonError('bad_args', `plugin folder '${directory}' is not a folder`);
    }
  }
}

// A path the daemon cannot stat, such as one under a folder it may not
// search, counts as missing.
function readPathKind(path: string): 'folder' | 'other' | 'missing' {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });

    if (stats === undefined) {
      return 'missing';
    }

    return stats.isDirectory() ? 'folder' : 'other';
  } catch {
    return 'missing';
  }
}
