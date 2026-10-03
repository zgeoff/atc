import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The directories one level under each configured root, plus every
 * worktree under those: `~/projects/atc` and `~/projects/atc/.worktrees/fix`
 * both list for a root of `~/projects`. Hidden directories are skipped, a
 * root that cannot be read contributes nothing, and the result is sorted
 * per root so the list is stable between opens.
 */
export function collectRootDirs(roots: readonly string[]): string[] {
  const found: string[] = [];

  for (const root of roots) {
    for (const child of collectChildDirs(root)) {
      found.push(child, ...collectChildDirs(join(child, '.worktrees')));
    }
  }

  return found;
}

function collectChildDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(dir, entry.name))
      .toSorted();
  } catch {
    return [];
  }
}
