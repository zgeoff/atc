import type { WorkspacesConfig } from '../shared/collect-workspaces-config';
import { resolveHomeDir } from '../shared/resolve-home-dir';

type WorkspaceRoot =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly message: string };

interface RootTarget {
  readonly id: string;

  // Whether the target is the daemon's own machine, where `~` is this
  // user's home.
  readonly inPlace: boolean;
}

// Where checkouts land on the daemon's own machine without a configured root.
const DEFAULT_ROOT = '~/.local/share/atc/workspaces';

/**
 * The directory git workspaces land under on a target: the target's own
 * root, else the global root, else the default. On the daemon's own
 * machine a leading `~` expands to the home directory. On any other target
 * the root must be absolute, since `~` there is a home this client cannot
 * see, so a root that is not is refused with the config key to set.
 */
export function resolveWorkspaceRoot(config: WorkspacesConfig, target: RootTarget): WorkspaceRoot {
  const configured = config.targetRoots.get(target.id) ?? config.root;

  if (target.inPlace) {
    const root = expandHome(configured ?? DEFAULT_ROOT);

    return root.startsWith('/')
      ? { ok: true, root }
      : { ok: false, message: `workspaces root '${root}' must be an absolute path` };
  }

  if (configured === null || !configured.startsWith('/')) {
    return {
      ok: false,
      message: `set workspaces.targets.${target.id} in config.json to an absolute path on that target`,
    };
  }

  return { ok: true, root: configured };
}

function expandHome(dir: string): string {
  return dir === '~' || dir.startsWith('~/') ? `${resolveHomeDir()}${dir.slice(1)}` : dir;
}
