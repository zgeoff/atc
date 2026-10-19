import { existsSync } from 'node:fs';
import { DaemonError } from '@atc/protocol/wire';

// A remote target's folders are out of the daemon's sight, so any folder
// there refuses the launch, as does a folder that does not exist.
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

  const missing = dirs.find((dir) => !existsSync(dir));

  if (missing !== undefined) {
    throw new DaemonError('bad_args', `plugin folder '${missing}' does not exist`);
  }
}
