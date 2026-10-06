import { posix } from 'node:path';
import { DaemonError } from '../protocol/daemon-error';
import type { SpawnWorkspaceSource } from '../protocol/request-param-schemas';
import { buildWorkspaceDestination } from '../shared/build-workspace-destination';

type GitWorkspaceSource = Extract<SpawnWorkspaceSource, { kind: 'git' }>;

interface DefaultDirTarget {
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

/**
 * The directory a git workspace lands in when the spawn gives none:
 * `<root>/<repo>-<ref>-<short sha>`, with the root the config sets, else
 * `~/.local/share/atc/workspaces`. A root under `~` resolves on the
 * target: against the daemon user's home on the daemon's own machine, and
 * on a remote target as a path relative to the target user's home, which
 * the host resolves, since only that host knows its home. Any other root
 * must be absolute.
 */
export function buildDefaultWorkspaceDir(
  source: GitWorkspaceSource,
  target: DefaultDirTarget,
): string {
  const configured = target.root ?? DEFAULT_ROOT;

  const parts = {
    url: source.url,
    ref: source.ref ?? null,
    sha: source.sha ?? null,
  };

  if (configured.startsWith('/')) {
    return buildWorkspaceDestination({ root: posix.normalize(configured), ...parts });
  }

  if (configured !== '~' && !configured.startsWith('~/')) {
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

  return target.remote
    ? buildWorkspaceDestination({ root: underHome, ...parts })
    : buildWorkspaceDestination({ root: posix.join(target.home, underHome), ...parts });
}
