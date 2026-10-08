import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { buildStubRecordingFilter } from '../test-utils/build-stub-recording-filter';
import { collectProcessTree } from '../test-utils/collect-process-tree';
import type { TreeProcess } from '../test-utils/collect-process-tree';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubBin } from '../test-utils/create-stub-bin';
import { startGitHTTPServer } from '../test-utils/start-git-http-server';
import { updateEnv } from '../test-utils/update-env';
import { createWorkspaceClone } from './create-workspace-clone';

// A bare upstream holding one pushed commit and a work clone of it.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-clone-' });

  return {
    dir: fixture.dir,
    env: fixture.env,
    upstream: fixture.upstream,
    work: fixture.work,
  };
}

test('it checks out the commit a branch points at, on that branch', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: ctx.upstream, ref: 'main' },
    dir: join(ctx.dir, 'clone'),
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(join(ctx.dir, 'clone')).text();

  const branch = await $`git symbolic-ref --short HEAD`
    .env(ctx.env)
    .cwd(join(ctx.dir, 'clone'))
    .text();

  expect(clone).toStrictEqual({ ok: true, sha: pushed, branch: 'main' });
  expect(head.trim()).toBe(pushed);
  expect(branch.trim()).toBe('main');
});

test('it checks out the commit an annotated tag points at, detached', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await $`git tag -a v1 -m v1`.env(ctx.env).cwd(ctx.work).quiet();

  await writeFile(join(ctx.work, 'README.md'), 'after the tag\n');

  await $`git commit --quiet -am later`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main v1`.env(ctx.env).cwd(ctx.work).quiet();

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: ctx.upstream, ref: 'v1' },
    dir: join(ctx.dir, 'clone'),
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(join(ctx.dir, 'clone')).text();

  expect(clone).toStrictEqual({ ok: true, sha: pushed, branch: null });
  expect(head.trim()).toBe(pushed);
});

test('it checks out a full commit id detached', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await writeFile(join(ctx.work, 'README.md'), 'later\n');

  await $`git commit --quiet -am later`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: ctx.upstream, ref: pushed },
    dir: join(ctx.dir, 'clone'),
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(join(ctx.dir, 'clone')).text();

  expect(clone).toStrictEqual({ ok: true, sha: pushed, branch: null });
  expect(head.trim()).toBe(pushed);
});

test('it copies objects instead of hard-linking them from a local upstream', async () => {
  const ctx = await setupTest();

  await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: ctx.upstream, ref: 'main' },
    dir: join(ctx.dir, 'clone'),
  });

  const linked = await $`find ${join(ctx.dir, 'clone', '.git', 'objects')} -type f -links +1`
    .env(ctx.env)
    .text();

  const alternates = join(ctx.dir, 'clone', '.git', 'objects', 'info', 'alternates');

  expect(linked).toBe('');
  expect(existsSync(alternates)).toBeFalse();
});

test('it refuses a ref the upstream does not have', async () => {
  const ctx = await setupTest();

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: ctx.upstream, ref: 'missing' },
    dir: join(ctx.dir, 'clone'),
  });

  expect(clone).toStrictEqual({
    ok: false,
    code: 'ref_not_found',
    message: "origin has no branch or tag 'missing'",
  });
});

test('it refuses a full commit id the upstream does not have and leaves no directory', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.work, 'README.md'), 'unpushed\n');

  await $`git commit --quiet -am unpushed`.env(ctx.env).cwd(ctx.work).quiet();

  const unpushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: ctx.upstream, ref: unpushed },
    dir: join(ctx.dir, 'clone'),
  });

  expect(clone).toStrictEqual({
    ok: false,
    code: 'ref_not_found',
    message: `origin has no commit ${unpushed}`,
  });

  expect(existsSync(join(ctx.dir, 'clone'))).toBeFalse();
});

test('it refuses an upstream it cannot reach', async () => {
  const ctx = await setupTest();

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: join(ctx.dir, 'missing.git'), ref: 'main' },
    dir: join(ctx.dir, 'clone'),
  });

  expect(clone).toStrictEqual({
    ok: false,
    code: 'clone_failed',
    message: expect.toInclude(join(ctx.dir, 'missing.git')),
  });
});

test('it refuses an env credential whose variable is unset', async () => {
  const ctx = await setupTest();

  const server = startGitHTTPServer(ctx.dir, ctx.env);

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: `${server.url}upstream.git`, ref: 'main' },
    dir: join(ctx.dir, 'clone'),
    credential: { kind: 'env', name: 'ATC_TEST_UNSET_GIT_TOKEN' },
  });

  expect(clone).toStrictEqual({
    ok: false,
    code: 'credential_missing',
    message: 'the credential environment variable is unset or empty',
  });
});

// The argv and helper checks read /proc, which only Linux has.
test.skipIf(process.platform !== 'linux')(
  'it authenticates with an env credential that never reaches argv or outlives the clone',
  async () => {
    const ctx = await setupTest();

    // While a request is held, every process this test run started is
    // recorded, so the test can check what git and its helpers were started
    // with.
    const processes: TreeProcess[] = [];

    const server = startGitHTTPServer(ctx.dir, ctx.env, {
      onRequest: async () => {
        processes.push(...(await collectProcessTree(process.pid)));
      },
    });

    const pushed = await $`git rev-parse HEAD`
      .env(ctx.env)
      .cwd(ctx.work)
      .text()
      .then((text) => text.trim());

    updateEnv('ATC_TEST_GIT_TOKEN', 'tok-4f9c2e');

    const clone = await createWorkspaceClone({
      transports: ['https', 'ssh', 'http', 'file'],
      source: { kind: 'git', url: `${server.url}upstream.git`, ref: 'main' },
      dir: join(ctx.dir, 'clone'),
      credential: { kind: 'env', name: 'ATC_TEST_GIT_TOKEN' },
    });

    const config = await readFile(join(ctx.dir, 'clone', '.git', 'config'), 'utf8');

    const helpers = processes
      .map((entry) => entry.env['GIT_ASKPASS'])
      .filter((helper) => helper !== undefined);

    expect(clone).toStrictEqual({ ok: true, sha: pushed, branch: 'main' });
    expect(server.authorizations).not.toBeEmpty();

    expect(server.authorizations).toSatisfyAll(
      (header: string) =>
        header === `Basic ${Buffer.from('x-access-token:tok-4f9c2e').toString('base64')}`,
    );

    expect(processes).not.toBeEmpty();

    expect(processes).toSatisfyAll(
      (entry: TreeProcess) =>
        !entry.argv.join(' ').includes('tok-4f9c2e') &&
        !entry.argv.join(' ').includes('ATC_TEST_GIT_TOKEN'),
    );

    expect(helpers).not.toBeEmpty();
    expect(helpers).toSatisfyAll((helper: string) => !existsSync(helper));
    expect(config).not.toInclude('tok-4f9c2e');
  },
);

test('it refuses a git source whose commit holds a gitlink and leaves no directory', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await $`git update-index --add --cacheinfo ${`160000,${pushed},vendored`}`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await $`git commit --quiet -m gitlink`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const gitlink = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: ctx.upstream, ref: 'main' },
    dir: join(ctx.dir, 'clone'),
  });

  expect(clone).toStrictEqual({
    ok: false,
    code: 'has_submodules',
    message: `${gitlink} uses submodules`,
  });

  expect(existsSync(join(ctx.dir, 'clone'))).toBeFalse();
});

test('it refuses a git source that tracks LFS paths without running the host LFS filter', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.work, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');

  await writeFile(
    join(ctx.work, 'asset.bin'),
    'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n',
  );

  await $`git add .gitattributes asset.bin`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet -m lfs`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const tracking = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const marker = join(ctx.dir, 'filter-ran');

  createStubBin(ctx.dir, 'trap', buildStubRecordingFilter(marker));

  await writeFile(
    join(ctx.dir, 'gitconfig'),
    `[filter "lfs"]\n\tsmudge = ${join(ctx.dir, 'trap')}\n\tprocess = ${join(ctx.dir, 'trap')}\n\trequired = true\n`,
  );

  updateEnv('GIT_CONFIG_GLOBAL', join(ctx.dir, 'gitconfig'));

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: ctx.upstream, ref: 'main' },
    dir: join(ctx.dir, 'clone'),
  });

  expect(clone).toStrictEqual({
    ok: false,
    code: 'lfs_unsupported',
    message: `${tracking} tracks 1 path(s) through Git LFS`,
    count: 1,
    paths: ['asset.bin'],
  });

  expect(existsSync(marker)).toBeFalse();
  expect(existsSync(join(ctx.dir, 'clone'))).toBeFalse();
});

test('it checks out without running a filter from the host global git config', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const marker = join(ctx.dir, 'filter-ran');

  createStubBin(ctx.dir, 'trap', buildStubRecordingFilter(marker));

  await writeFile(join(ctx.dir, 'attributes'), '* filter=trap\n');

  await writeFile(
    join(ctx.dir, 'gitconfig'),
    `[core]\n\tattributesFile = ${join(ctx.dir, 'attributes')}\n[filter "trap"]\n\tsmudge = ${join(ctx.dir, 'trap')}\n`,
  );

  updateEnv('GIT_CONFIG_GLOBAL', join(ctx.dir, 'gitconfig'));

  const clone = await createWorkspaceClone({
    transports: ['https', 'ssh', 'http', 'file'],
    source: { kind: 'git', url: ctx.upstream, ref: 'main' },
    dir: join(ctx.dir, 'clone'),
  });

  const readme = await readFile(join(ctx.dir, 'clone', 'README.md'), 'utf8');

  expect(clone).toStrictEqual({ ok: true, sha: pushed, branch: 'main' });
  expect(existsSync(marker)).toBeFalse();
  expect(readme).toBe('hello\n');
});
