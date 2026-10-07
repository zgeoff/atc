import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { resolveRepoRoot } from './resolve-repo-root';

test('it resolves a directory inside a repository to the repository root', () => {
  using tmp = setupTempDir('atc-repo-root-');

  const repo = join(tmp.dir, 'repo');

  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });

  expect(resolveRepoRoot(join(repo, 'src', 'deep'))).toBe(repo);
});

test('it resolves a linked worktree to the main repository root', () => {
  using tmp = setupTempDir('atc-repo-root-');

  const repo = join(tmp.dir, 'repo');
  const worktree = join(repo, '.worktrees', 'feature');

  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feature')}\n`);

  expect(resolveRepoRoot(worktree)).toBe(repo);
});

test('it resolves a directory outside any repository to itself', () => {
  using tmp = setupTempDir('atc-repo-root-');

  const loose = join(tmp.dir, 'loose');

  mkdirSync(loose, { recursive: true });

  expect(resolveRepoRoot(loose)).toBe(loose);
});

test('it keeps a submodule-style .git file directory as its own root', () => {
  using tmp = setupTempDir('atc-repo-root-');

  const mod = join(tmp.dir, 'mod');

  mkdirSync(mod, { recursive: true });
  writeFileSync(join(mod, '.git'), `gitdir: ${join(tmp.dir, '.git', 'modules', 'mod')}\n`);

  expect(resolveRepoRoot(mod)).toBe(mod);
});

// A `.git` directory with nothing in it turns up in shared temporary
// directories, and reading it as a root clusters every session under `/tmp`.
test('it walks past a .git directory that holds no HEAD', () => {
  using tmp = setupTempDir('atc-repo-root-');

  const loose = join(tmp.dir, 'loose');

  mkdirSync(join(tmp.dir, '.git'), { recursive: true });
  mkdirSync(loose, { recursive: true });

  expect(resolveRepoRoot(loose)).toBe(loose);
});

// The stack restores the mode before it removes the temp directory, since
// nothing can remove a tree it cannot read.
test('it resolves a directory under an unreadable ancestor to itself', () => {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-repo-root-'));
  const locked = join(tmp.dir, 'locked');
  const cwd = join(locked, 'work');

  mkdirSync(cwd, { recursive: true });
  chmodSync(locked, 0o000);

  stack.defer(() => {
    chmodSync(locked, 0o700);
  });

  expect(resolveRepoRoot(cwd)).toBe(cwd);
});

test('it resolves a nested repository with an unreadable .git to itself, not the outer repository', () => {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-repo-root-'));
  const outer = join(tmp.dir, 'outer');
  const inner = join(outer, 'inner');

  mkdirSync(join(outer, '.git'), { recursive: true });
  writeFileSync(join(outer, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(inner, '.git'), { recursive: true });
  writeFileSync(join(inner, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  chmodSync(join(inner, '.git'), 0o000);

  stack.defer(() => {
    chmodSync(join(inner, '.git'), 0o700);
  });

  expect(resolveRepoRoot(inner)).toBe(inner);
});
