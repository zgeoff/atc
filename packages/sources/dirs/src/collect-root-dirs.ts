import { readdirSync } from 'node:fs';
import { join } from 'node:path';

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
