import { expect, test } from 'bun:test';
import { $ } from 'bun';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import type { ExecutionProvider } from './execution-provider';
import { findHostBranch } from './find-host-branch';
import { LocalPTYProvider } from './local-pty-provider';

test('it finds the branch a directory has checked out', async () => {
  const fixture = await createGitFixture({ prefix: 'atc-host-branch-' });
  const branch = await findHostBranch(new LocalPTYProvider(), 's-1', fixture.work);

  expect(branch).toBe('main');
});

test('it finds no branch for a detached checkout', async () => {
  const fixture = await createGitFixture({ prefix: 'atc-host-branch-' });

  await $`git checkout --quiet --detach`.env(fixture.env).cwd(fixture.work);

  const branch = await findHostBranch(new LocalPTYProvider(), 's-1', fixture.work);

  expect(branch).toBeNull();
});

test('it finds no branch for a directory outside git', async () => {
  const tmp = setupTempDir('atc-host-branch-plain-');

  const branch = await findHostBranch(new LocalPTYProvider(), 's-1', tmp.dir);

  expect(branch).toBeNull();
});

test('it finds no branch on a remote host that runs no commands', async () => {
  const stub = buildStubExecutionProvider();

  const provider: ExecutionProvider = {
    ...stub,
    remote: true,
    capabilities: { ...stub.capabilities, run: false },
    runCommand: () => Promise.reject(new Error('the host runs no commands')),
  };

  const branch = await findHostBranch(provider, 's-1', '/work');

  expect(branch).toBeNull();
});
