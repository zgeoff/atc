import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRepoRoot } from './resolve-repo-root';

function setupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-repo-root-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

function setupRepo(repo: string): void {
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

test('it resolves a directory inside a repository to the repository root', () => {
  const dir = setupDir();
  const repo = join(dir, 'repo');

  setupRepo(repo);
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });

  expect(resolveRepoRoot(join(repo, 'src', 'deep'))).toBe(repo);
});

test('it resolves a linked worktree to the main repository root', () => {
  const dir = setupDir();
  const repo = join(dir, 'repo');
  const worktree = join(repo, '.worktrees', 'feature');

  setupRepo(repo);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feature')}\n`);

  expect(resolveRepoRoot(worktree)).toBe(repo);
});

test('it resolves a directory outside any repository to itself', () => {
  const dir = setupDir();
  const loose = join(dir, 'loose');

  mkdirSync(loose, { recursive: true });

  expect(resolveRepoRoot(loose)).toBe(loose);
});

test('it keeps a submodule-style .git file directory as its own root', () => {
  const dir = setupDir();
  const mod = join(dir, 'mod');

  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, '.git'), `gitdir: ${join(dir, '.git', 'modules', 'mod')}\n`);

  expect(resolveRepoRoot(mod)).toBe(mod);
});

// A `.git` directory with nothing in it turns up in shared temporary
// directories, and reading it as a root clusters every session under `/tmp`.
test('it walks past a .git directory that holds no HEAD', () => {
  const dir = setupDir();
  const loose = join(dir, 'loose');

  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(loose, { recursive: true });

  expect(resolveRepoRoot(loose)).toBe(loose);
});
