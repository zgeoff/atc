import { posix } from 'node:path';
import { isHomeRelative } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';

interface WorkspaceRootTarget {
  // The workspaces root the config sets for the target, else the global
  // one, else null for the default.
  readonly root: string | null;

  // Whether the target runs on another machine, whose home only that
  // machine knows.
  readonly remote: boolean;

  // The home directory of the daemon's own user.
  readonly home: string;
}

// Where checkouts land without a configured root, under the target user's
// home.
const DEFAULT_ROOT = '~/.local/share/atc/workspaces';

// An absolute folder, or on a remote target a folder relative to its user's home, which is empty
// for the home itself.
export function buildWorkspaceRootDir(target: WorkspaceRootTarget): string {
  const configured = target.root ?? DEFAULT_ROOT;

  if (configured.startsWith('/')) {
    return posix.normalize(configured);
  }

  if (!isHomeRelative(configured)) {
    throw new DaemonError(
      'bad_args',
      `workspaces root '${configured}' must be an absolute path or start with ~/`,
    );
  }

  const normalized = posix.normalize(`./${configured.slice(1)}`);
  const underHome = normalized === './' || normalized === '.' ? '' : normalized;

  if (underHome === '..' || underHome.startsWith('../')) {
    throw new DaemonError(
      'bad_args',
      `workspaces root '${configured}' must stay under the home directory`,
    );
  }

  // a remote target resolves the home-relative path itself, since only that host knows its home
  return target.remote ? underHome : posix.join(target.home, underHome);
}
