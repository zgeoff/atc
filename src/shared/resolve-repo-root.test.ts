import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { resolveRepoRoot } from './resolve-repo-root';

function setupTest() {
  const tmp = setupTempDir('atc-repo-root-');

  // A test may leave a directory unreadable, and nothing can remove a tree
  // it cannot read, so every mode is restored before the tree is removed.
  registerTestCleanup(async () => {
    await Bun.spawn(['chmod', '-R', 'u+rwx', tmp.dir]).exited;
  });

  return { dir: tmp.dir };
}

test('it resolves a directory inside a repository to the repository root', () => {
  const ctx = setupTest();
  const repo = join(ctx.dir, 'repo');

  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });

  expect(resolveRepoRoot(join(repo, 'src', 'deep'))).toBe(repo);
});

test('it resolves a linked worktree to the main repository root', () => {
  const ctx = setupTest();
  const repo = join(ctx.dir, 'repo');
  const worktree = join(repo, '.worktrees', 'feature');

  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feature')}\n`);

  expect(resolveRepoRoot(worktree)).toBe(repo);
});

test('it resolves a directory outside any repository to itself', () => {
  const ctx = setupTest();
  const loose = join(ctx.dir, 'loose');

  mkdirSync(loose, { recursive: true });

  expect(resolveRepoRoot(loose)).toBe(loose);
});

test('it keeps a submodule-style .git file directory as its own root', () => {
  const ctx = setupTest();
  const mod = join(ctx.dir, 'mod');

  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, '.git'), `gitdir: ${join(ctx.dir, '.git', 'modules', 'mod')}\n`);

  expect(resolveRepoRoot(mod)).toBe(mod);
});

// A `.git` directory with nothing in it turns up in shared temporary
// directories, and reading it as a root clusters every session under `/tmp`.
test('it walks past a .git directory that holds no HEAD', () => {
  const ctx = setupTest();
  const loose = join(ctx.dir, 'loose');

  mkdirSync(join(ctx.dir, '.git'), { recursive: true });
  mkdirSync(loose, { recursive: true });

  expect(resolveRepoRoot(loose)).toBe(loose);
});

test('it resolves a directory under an unreadable ancestor to itself', () => {
  const ctx = setupTest();
  const locked = join(ctx.dir, 'locked');
  const cwd = join(locked, 'work');

  mkdirSync(cwd, { recursive: true });
  chmodSync(locked, 0o000);

  expect(resolveRepoRoot(cwd)).toBe(cwd);
});

test('it resolves a nested repository with an unreadable .git to itself, not the outer repository', () => {
  const ctx = setupTest();
  const outer = join(ctx.dir, 'outer');
  const inner = join(outer, 'inner');

  mkdirSync(join(outer, '.git'), { recursive: true });
  writeFileSync(join(outer, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(inner, '.git'), { recursive: true });
  writeFileSync(join(inner, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  chmodSync(join(inner, '.git'), 0o000);

  expect(resolveRepoRoot(inner)).toBe(inner);
});
