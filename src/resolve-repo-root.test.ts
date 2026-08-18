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

test('it resolves a directory inside a repository to the repository root', () => {
  const dir = setupDir();
  const repo = join(dir, 'repo');

  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });

  expect(resolveRepoRoot(join(repo, 'src', 'deep'))).toBe(repo);
});

test('it resolves a linked worktree to the main repository root', () => {
  const dir = setupDir();
  const repo = join(dir, 'repo');
  const worktree = join(repo, '.worktrees', 'feature');

  mkdirSync(join(repo, '.git'), { recursive: true });
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
