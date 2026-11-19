import type { WorkspacesConfig } from '@atc/config';
import { expandHome } from '@atc/core';
import { resolveHomeDir } from '@atcx/contract/light';

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

export function resolveWorkspaceRoot(
  config: WorkspacesConfig,
  target: RootTarget,
  home: string = resolveHomeDir(),
): WorkspaceRoot {
  const configured = config.targetRoots.get(target.id) ?? config.root;

  if (target.inPlace) {
    const root = expandHome(configured ?? DEFAULT_ROOT, home);

    return root.startsWith('/')
      ? { ok: true, root }
      : { ok: false, message: `workspaces root '${root}' must be an absolute path` };
  }

  // `~` on another target is a home this client cannot see.
  if (configured === null || !configured.startsWith('/')) {
    return {
      ok: false,
      message: `set workspaces.targets.${target.id} in config.json to an absolute path on that target`,
    };
  }

  return { ok: true, root: configured };
}
