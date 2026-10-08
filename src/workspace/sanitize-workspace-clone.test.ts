import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { sanitizeWorkspaceClone } from './sanitize-workspace-clone';

// A work clone of a bare upstream, holding one pushed commit, for the sanitizer to strip.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-sanitize-' });

  return { env: fixture.env, work: fixture.work };
}

test('it removes every credential setting from the clone config', async () => {
  const ctx = await setupTest();

  await $`git config --local credential.helper store`.env(ctx.env).cwd(ctx.work).quiet();

  await $`git config --local credential.https://github.com.username bob`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await $`git config --local credential.https://github.com.helper '!echo password=tok'`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');

  const remaining = await $`git config --local --get-regexp ^credential\\.`
    .env(ctx.env)
    .cwd(ctx.work)
    .nothrow()
    .text();

  expect(remaining).toBe('');
});

test('it removes an http extra header that could carry a token', async () => {
  const ctx = await setupTest();

  await $`git config --local http.https://github.com/.extraheader 'Authorization: Bearer tok'`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');

  const config = await $`git config --local --list`.env(ctx.env).cwd(ctx.work).text();

  expect(config).not.toInclude('tok');
});

test('it resets a token-bearing origin URL to the token-free one', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await $`git config --local remote.origin.url https://x-access-token:tok@github.com/zgeoff/atc.git`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  const sanitized = await sanitizeWorkspaceClone(
    ctx.work,
    'https://x-access-token:tok@github.com/zgeoff/atc.git',
  );

  const origin = await $`git config --local remote.origin.url`.env(ctx.env).cwd(ctx.work).text();

  expect(sanitized).toStrictEqual({
    ok: true,
    provenance: { repoURL: 'https://github.com/zgeoff/atc.git', sha: pushed },
  });

  expect(origin.trim()).toBe('https://github.com/zgeoff/atc.git');
});

test('it removes a token-bearing push URL from another remote', async () => {
  const ctx = await setupTest();

  await $`git config --local remote.fork.pushurl https://tok@github.com/fork/atc.git`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');

  const config = await $`git config --local --list`.env(ctx.env).cwd(ctx.work).text();

  expect(config).not.toInclude('tok');
});

test('it keeps an ssh origin user, which is a login rather than a credential', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const sanitized = await sanitizeWorkspaceClone(ctx.work, 'ssh://git@github.com/zgeoff/atc.git');

  expect(sanitized).toStrictEqual({
    ok: true,
    provenance: { repoURL: 'ssh://git@github.com/zgeoff/atc.git', sha: pushed },
  });
});

test('it removes a URL rewrite that injects userinfo and keeps a clean one', async () => {
  const ctx = await setupTest();

  await $`git config --local url.https://tok@github.com/.insteadOf https://github.com/`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await $`git config --local url.https://mirror.example.com/.insteadOf https://gitlab.example.com/`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');

  const rewrites = await $`git config --local --get-regexp ^url\\.`
    .env(ctx.env)
    .cwd(ctx.work)
    .text();

  expect(rewrites).toBe('url.https://mirror.example.com/.insteadof https://gitlab.example.com/\n');
});

test('it removes every hook', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.work, '.git', 'hooks'), { recursive: true });

  await writeFile(join(ctx.work, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });

  await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');

  const hooks = await readdir(join(ctx.work, '.git', 'hooks'));

  expect(hooks).toStrictEqual([]);
});

test('it removes credential files from the work tree and the git directory', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.work, '.git-credentials'), 'https://bob:tok@github.com\n');
  await writeFile(join(ctx.work, '.netrc'), 'machine github.com password tok\n');
  await writeFile(join(ctx.work, '.git', '.git-credentials'), 'https://bob:tok@github.com\n');
  await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');

  expect(existsSync(join(ctx.work, '.git-credentials'))).toBeFalse();
  expect(existsSync(join(ctx.work, '.netrc'))).toBeFalse();
  expect(existsSync(join(ctx.work, '.git', '.git-credentials'))).toBeFalse();
});

test('it never removes an ordinary work-tree file', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await mkdir(join(ctx.work, 'src'), { recursive: true });
  await writeFile(join(ctx.work, 'notes.md'), 'remember the milk\n');
  await writeFile(join(ctx.work, 'src', 'index.ts'), 'export {};\n');

  const sanitized = await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');
  const notes = await readFile(join(ctx.work, 'notes.md'), 'utf8');
  const index = await readFile(join(ctx.work, 'src', 'index.ts'), 'utf8');

  expect(sanitized).toStrictEqual({
    ok: true,
    provenance: { repoURL: 'https://github.com/zgeoff/atc.git', sha: pushed },
  });

  expect(notes).toBe('remember the milk\n');
  expect(index).toBe('export {};\n');
});

test('it removes the reflogs the clone holds', async () => {
  const ctx = await setupTest();
  const before = await readFile(join(ctx.work, '.git', 'logs', 'HEAD'), 'utf8');

  await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');

  expect(before).toInclude('commit (initial): initial');
  expect(existsSync(join(ctx.work, '.git', 'logs'))).toBeFalse();
});

test('it keeps HEAD, the branch, and a readable history', async () => {
  const ctx = await setupTest();

  const pushed = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  await $`git config --local credential.helper store`.env(ctx.env).cwd(ctx.work).quiet();

  const sanitized = await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');
  const logged = await $`git log -1 --format=%H`.env(ctx.env).cwd(ctx.work).text();
  const branch = await $`git symbolic-ref --short HEAD`.env(ctx.env).cwd(ctx.work).text();

  expect(sanitized).toStrictEqual({
    ok: true,
    provenance: { repoURL: 'https://github.com/zgeoff/atc.git', sha: pushed },
  });

  expect(logged.trim()).toBe(pushed);
  expect(branch.trim()).toBe('main');
});

test('it refuses a clone whose history no longer reads', async () => {
  const ctx = await setupTest();

  await rm(join(ctx.work, '.git', 'objects'), { recursive: true, force: true });
  await mkdir(join(ctx.work, '.git', 'objects'));

  const sanitized = await sanitizeWorkspaceClone(ctx.work, 'https://github.com/zgeoff/atc.git');

  expect(sanitized).toStrictEqual({
    ok: false,
    code: 'sanitize_failed',
    message: expect.toStartWith('history unreadable: '),
  });
});

test('it refuses a URL it cannot read as a repository URL', async () => {
  const ctx = await setupTest();
  const sanitized = await sanitizeWorkspaceClone(ctx.work, 'not a url');

  expect(sanitized).toStrictEqual({
    ok: false,
    code: 'invalid_git_url',
    message: 'not a git repository URL',
  });
});
