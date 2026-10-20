import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function readRootDirs(roots: readonly string[]): string[] {
  const found: string[] = [];

  for (const root of roots) {
    for (const child of readChildDirs(root)) {
      found.push(child, ...readChildDirs(join(child, '.worktrees')));
    }
  }

  return found;
}

function readChildDirs(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(directory, entry.name))
      .toSorted();
  } catch {
    return [];
  }
}
