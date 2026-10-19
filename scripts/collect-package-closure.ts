import type { WorkspacePackage } from './load-workspace-packages';

// The named packages and every workspace package their manifests depend on,
// directly or through another package, in the order the walk finds them.
export function collectPackageClosure(
  workspace: readonly WorkspacePackage[],
  names: readonly string[],
): WorkspacePackage[] {
  const found = new Map<string, WorkspacePackage>();

  const pending = [...names];

  while (pending.length > 0) {
    const name = pending.pop();
    const pkg = workspace.find((candidate) => candidate.name === name);

    if (pkg !== undefined && !found.has(pkg.name)) {
      found.set(pkg.name, pkg);
      pending.push(...pkg.deps);
    }
  }

  return [...found.values()];
}
