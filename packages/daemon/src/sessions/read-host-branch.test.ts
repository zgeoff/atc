import { expect, test } from 'bun:test';
import { createGitFixture, setupTempDir } from '@atc/test-utils';
import { $ } from 'bun';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { runLocalCommand } from '../testing/run-local-command';
import { readHostBranch } from './read-host-branch';

test('it finds the branch a directory has checked out', async () => {
  const fixture = await createGitFixture({ prefix: 'atc-host-branch-' });

  const provider = buildStubMemoryProvider({ kind: 'local-pty', runCommand: runLocalCommand });

  const branch = await readHostBranch(provider, 's-1', fixture.work);

  expect(branch).toBe('main');
});

test('it finds no branch for a detached checkout', async () => {
  const fixture = await createGitFixture({ prefix: 'atc-host-branch-' });

  const provider = buildStubMemoryProvider({ kind: 'local-pty', runCommand: runLocalCommand });

  await $`git checkout --quiet --detach`.env(fixture.env).cwd(fixture.work);

  const branch = await readHostBranch(provider, 's-1', fixture.work);

  expect(branch).toBeNull();
});

test('it finds no branch for a directory outside git', async () => {
  const tmp = setupTempDir('atc-host-branch-plain-');
  const provider = buildStubMemoryProvider({ kind: 'local-pty', runCommand: runLocalCommand });

  const branch = await readHostBranch(provider, 's-1', tmp.dir);

  expect(branch).toBeNull();
});

test('it finds no branch on a remote host that runs no commands', async () => {
  const provider = buildStubMemoryProvider({
    remote: true,
    capabilities: { run: false },
    runCommand: () => Promise.reject(new Error('the host runs no commands')),
  });

  const branch = await readHostBranch(provider, 's-1', '/work');

  expect(branch).toBeNull();
});
