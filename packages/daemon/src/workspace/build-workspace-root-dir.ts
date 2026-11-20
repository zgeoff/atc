import { posix } from 'node:path';
import { isHomeRelative } from '@atc/core';
import { AtcError } from '@atcx/contract/light';

interface WorkspaceRootTarget {
  readonly root: string | null;

  readonly remote: boolean;

  readonly home: string;
}

const DEFAULT_ROOT = '~/.local/share/atc/workspaces';

export function buildWorkspaceRootDir(target: WorkspaceRootTarget): string {
  const configured = target.root ?? DEFAULT_ROOT;

  if (configured.startsWith('/')) {
    return posix.normalize(configured);
  }

  if (!isHomeRelative(configured)) {
    throw new AtcError(
      'bad_args',
      `workspaces root '${configured}' must be an absolute path or start with ~/`,
    );
  }

  const normalized = posix.normalize(`./${configured.slice(1)}`);
  const underHome = normalized === './' || normalized === '.' ? '' : normalized;

  if (underHome === '..' || underHome.startsWith('../')) {
    throw new AtcError(
      'bad_args',
      `workspaces root '${configured}' must stay under the home directory`,
    );
  }

  // Only the remote host knows its own home, so the daemon returns the home-relative path
  // unresolved and lets that host expand it.
  return target.remote ? underHome : posix.join(target.home, underHome);
}
