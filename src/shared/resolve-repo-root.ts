import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The repository a directory belongs to, for clustering sessions in the
 * overlay. Walks toward the filesystem root looking for a `.git` entry: a
 * directory holding HEAD marks the repository root itself, and a linked
 * worktree's `.git` file points back at the main repository, so worktrees
 * cluster with it. A directory outside any repository resolves to itself.
 */
export function resolveRepoRoot(cwd: string): string {
  let dir = cwd;

  while (true) {
    const marker = join(dir, '.git');
    const stat = statSync(marker, { throwIfNoEntry: false });

    if (stat !== undefined && stat.isDirectory() && hasGitHead(marker)) {
      return dir;
    }

    if (stat !== undefined && stat.isFile()) {
      return findMainRoot(marker) ?? dir;
    }

    const parent = dirname(dir);

    if (parent === dir) {
      return cwd;
    }

    dir = parent;
  }
}

/**
 * Whether a `.git` directory is a repository rather than an empty directory
 * that happens to carry the name. git needs HEAD in one, and a stray `.git` in
 * a shared temporary directory would otherwise cluster every session under it.
 */
function hasGitHead(marker: string): boolean {
  return statSync(join(marker, 'HEAD'), { throwIfNoEntry: false }) !== undefined;
}

// A linked worktree's `.git` file reads `gitdir: <main>/.git/worktrees/<name>`.
function findMainRoot(gitFile: string): string | null {
  try {
    const gitdir = /^gitdir:\s*(?<dir>.+)$/mu
      .exec(readFileSync(gitFile, 'utf8'))
      ?.groups?.['dir']?.trim();

    if (gitdir === undefined) {
      return null;
    }

    return /^(?<root>.+)\/\.git\/worktrees\/[^/]+$/u.exec(gitdir)?.groups?.['root'] ?? null;
  } catch {
    return null;
  }
}
