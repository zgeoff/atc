import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { sanitizeWorkspaceClone } from './sanitize-workspace-clone';

test('it removes every credential setting from the clone config', async () => {
  await using fixture = await createGitFixture();

  await $`git config --local credential.helper store`.env(fixture.env).cwd(fixture.work).quiet();

  await $`git config --local credential.https://github.com.username bob`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  await $`git config --local credential.https://github.com.helper '!echo password=tok'`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  await sanitizeWorkspaceClone(fixture.work, 'https://github.com/zgeoff/atc.git');

  const remaining = await $`git config --local --get-regexp ^credential\\.`
    .env(fixture.env)
    .cwd(fixture.work)
    .nothrow()
    .text();

  expect(remaining).toBe('');
});

test('it removes an http extra header that could carry a token', async () => {
  await using fixture = await createGitFixture();

  await $`git config --local http.https://github.com/.extraheader 'Authorization: Bearer tok'`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  await sanitizeWorkspaceClone(fixture.work, 'https://github.com/zgeoff/atc.git');

  const config = await $`git config --local --list`.env(fixture.env).cwd(fixture.work).text();

  expect(config).not.toInclude('tok');
});

test('it resets a token-bearing origin URL to the token-free one', async () => {
  await using fixture = await createGitFixture();

  await $`git config --local remote.origin.url https://x-access-token:tok@github.com/zgeoff/atc.git`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  const sanitized = await sanitizeWorkspaceClone(
    fixture.work,
    'https://x-access-token:tok@github.com/zgeoff/atc.git',
  );

  const origin = await $`git config --local remote.origin.url`
    .env(fixture.env)
    .cwd(fixture.work)
    .text();

  expect(sanitized).toStrictEqual({
    ok: true,
    provenance: { repoURL: 'https://github.com/zgeoff/atc.git', sha: fixture.sha },
  });

  expect(origin.trim()).toBe('https://github.com/zgeoff/atc.git');
});

test('it removes a token-bearing push URL from another remote', async () => {
  await using fixture = await createGitFixture();

  await $`git config --local remote.fork.pushurl https://tok@github.com/fork/atc.git`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  await sanitizeWorkspaceClone(fixture.work, 'https://github.com/zgeoff/atc.git');

  const config = await $`git config --local --list`.env(fixture.env).cwd(fixture.work).text();

  expect(config).not.toInclude('tok');
});

test('it keeps an ssh origin user, which is a login rather than a credential', async () => {
  await using fixture = await createGitFixture();

  const sanitized = await sanitizeWorkspaceClone(
    fixture.work,
    'ssh://git@github.com/zgeoff/atc.git',
  );

  expect(sanitized).toStrictEqual({
    ok: true,
    provenance: { repoURL: 'ssh://git@github.com/zgeoff/atc.git', sha: fixture.sha },
  });
});

test('it removes a URL rewrite that injects userinfo and keeps a clean one', async () => {
  await using fixture = await createGitFixture();

  await $`git config --local url.https://tok@github.com/.insteadOf https://github.com/`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  await $`git config --local url.https://mirror.example.com/.insteadOf https://gitlab.example.com/`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  await sanitizeWorkspaceClone(fixture.work, 'https://github.com/zgeoff/atc.git');

  const rewrites = await $`git config --local --get-regexp ^url\\.`
    .env(fixture.env)
    .cwd(fixture.work)
    .text();

  expect(rewrites).toBe('url.https://mirror.example.com/.insteadof https://gitlab.example.com/\n');
});

test('it removes every hook', async () => {
  await using fixture = await createGitFixture();

  await mkdir(join(fixture.work, '.git', 'hooks'), { recursive: true });

  await writeFile(join(fixture.work, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });

  await sanitizeWorkspaceClone(fixture.work, 'https://github.com/zgeoff/atc.git');

  const hooks = await readdir(join(fixture.work, '.git', 'hooks'));

  expect(hooks).toStrictEqual([]);
});

test('it removes credential files from the work tree and the git directory', async () => {
  await using fixture = await createGitFixture();

  await writeFile(join(fixture.work, '.git-credentials'), 'https://bob:tok@github.com\n');
  await writeFile(join(fixture.work, '.netrc'), 'machine github.com password tok\n');
  await writeFile(join(fixture.work, '.git', '.git-credentials'), 'https://bob:tok@github.com\n');
  await sanitizeWorkspaceClone(fixture.work, 'https://github.com/zgeoff/atc.git');

  expect([
    join(fixture.work, '.git-credentials'),
    join(fixture.work, '.netrc'),
    join(fixture.work, '.git', '.git-credentials'),
  ]).toSatisfyAll((file: string) => !existsSync(file));
});

test('it removes the reflogs that record the clone URL', async () => {
  await using fixture = await createGitFixture();

  await sanitizeWorkspaceClone(fixture.work, 'https://github.com/zgeoff/atc.git');

  expect(existsSync(join(fixture.work, '.git', 'logs'))).toBeFalse();
});

test('it keeps HEAD, the branch, and a readable history', async () => {
  await using fixture = await createGitFixture();

  await $`git config --local credential.helper store`.env(fixture.env).cwd(fixture.work).quiet();

  const sanitized = await sanitizeWorkspaceClone(fixture.work, 'https://github.com/zgeoff/atc.git');
  const logged = await $`git log -1 --format=%H`.env(fixture.env).cwd(fixture.work).text();
  const branch = await $`git symbolic-ref --short HEAD`.env(fixture.env).cwd(fixture.work).text();

  expect(sanitized).toStrictEqual({
    ok: true,
    provenance: { repoURL: 'https://github.com/zgeoff/atc.git', sha: fixture.sha },
  });

  expect(logged.trim()).toBe(fixture.sha);
  expect(branch.trim()).toBe('main');
});

test('it refuses a clone whose history no longer reads', async () => {
  await using fixture = await createGitFixture();

  await rm(join(fixture.work, '.git', 'objects'), { recursive: true, force: true });
  await mkdir(join(fixture.work, '.git', 'objects'));

  const sanitized = await sanitizeWorkspaceClone(fixture.work, 'https://github.com/zgeoff/atc.git');

  expect(sanitized).toStrictEqual({
    ok: false,
    code: 'sanitize_failed',
    message: expect.toStartWith('history unreadable: '),
  });
});

test('it refuses a URL it cannot read as a repository URL', async () => {
  await using fixture = await createGitFixture();

  const sanitized = await sanitizeWorkspaceClone(fixture.work, 'not a url');

  expect(sanitized).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: 'not a git repository URL',
  });
});
