import type { WorkspacesConfig } from '@atc/config';
import { isHomeRelative } from '@atc/core';

// The daemon resolves a remote target's root under the target user's home,
// so a root the config gives as an absolute path leaves it nothing to pick.
export function canPickOnTarget(workspaces: WorkspacesConfig, target: string): boolean {
  const configured = workspaces.targetRoots.get(target) ?? workspaces.root;

  return configured === null || isHomeRelative(configured);
}
