import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { sanitizeWorkspaceClone } from './sanitize-workspace-clone';

async function setupTest() {
  // A git hook exports GIT_DIR and friends, which would point these
  // commands at the repository running the hook instead of the temp tree.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );

  const dir = await mkdtemp(join(tmpdir(), 'atc-sanitize-'));

  const upstream = join(dir, 'upstream.git');
  const work = join(dir, 'work');
  const clone = join(dir, 'clone');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();
  await $`git config user.name atc`.env(env).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(env).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(env).cwd(work).quiet();

  await writeFile(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();
  await $`git clone --quiet --no-local --template= ${upstream} ${clone}`.env(env).quiet();

  return {
    env,
    dir,
    clone,
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it removes every credential setting from the clone config', async () => {
  await using project = await setupTest();

  await $`git config --local credential.helper store`.env(project.env).cwd(project.clone).quiet();

  await $`git config --local credential.https://github.com.username bob`
    .env(project.env)
    .cwd(project.clone)
    .quiet();

  await $`git config --local credential.https://github.com.helper '!echo password=tok'`
    .env(project.env)
    .cwd(project.clone)
    .quiet();

  await sanitizeWorkspaceClone(project.clone, 'https://github.com/zgeoff/atc.git');

  const remaining = await $`git config --local --get-regexp ^credential\\.`
    .env(project.env)
    .cwd(project.clone)
    .nothrow()
    .text();

  expect(remaining).toBe('');
});

test('it removes an http extra header that could carry a token', async () => {
  await using project = await setupTest();

  await $`git config --local http.https://github.com/.extraheader 'Authorization: Bearer tok'`
    .env(project.env)
    .cwd(project.clone)
    .quiet();

  await sanitizeWorkspaceClone(project.clone, 'https://github.com/zgeoff/atc.git');

  const config = await $`git config --local --list`.env(project.env).cwd(project.clone).text();

  expect(config).not.toInclude('tok');
});

test('it resets a token-bearing origin URL to the token-free one', async () => {
  await using project = await setupTest();

  await $`git config --local remote.origin.url https://x-access-token:tok@github.com/zgeoff/atc.git`
    .env(project.env)
    .cwd(project.clone)
    .quiet();

  const sanitized = await sanitizeWorkspaceClone(
    project.clone,
    'https://x-access-token:tok@github.com/zgeoff/atc.git',
  );

  const origin = await $`git config --local remote.origin.url`
    .env(project.env)
    .cwd(project.clone)
    .text();

  expect(sanitized).toMatchObject({
    ok: true,
    provenance: { repoURL: 'https://github.com/zgeoff/atc.git' },
  });

  expect(origin.trim()).toBe('https://github.com/zgeoff/atc.git');
});

test('it removes a token-bearing push URL from another remote', async () => {
  await using project = await setupTest();

  await $`git config --local remote.fork.pushurl https://tok@github.com/fork/atc.git`
    .env(project.env)
    .cwd(project.clone)
    .quiet();

  await sanitizeWorkspaceClone(project.clone, 'https://github.com/zgeoff/atc.git');

  const config = await $`git config --local --list`.env(project.env).cwd(project.clone).text();

  expect(config).not.toInclude('tok');
});

test('it keeps an ssh origin user, which is a login rather than a credential', async () => {
  await using project = await setupTest();

  const sanitized = await sanitizeWorkspaceClone(
    project.clone,
    'ssh://git@github.com/zgeoff/atc.git',
  );

  expect(sanitized).toMatchObject({
    ok: true,
    provenance: { repoURL: 'ssh://git@github.com/zgeoff/atc.git' },
  });
});

test('it removes a URL rewrite that injects userinfo and keeps a clean one', async () => {
  await using project = await setupTest();

  await $`git config --local url.https://tok@github.com/.insteadOf https://github.com/`
    .env(project.env)
    .cwd(project.clone)
    .quiet();

  await $`git config --local url.https://mirror.example.com/.insteadOf https://gitlab.example.com/`
    .env(project.env)
    .cwd(project.clone)
    .quiet();

  await sanitizeWorkspaceClone(project.clone, 'https://github.com/zgeoff/atc.git');

  const rewrites = await $`git config --local --get-regexp ^url\\.`
    .env(project.env)
    .cwd(project.clone)
    .text();

  expect(rewrites).toBe('url.https://mirror.example.com/.insteadof https://gitlab.example.com/\n');
});

test('it removes every hook', async () => {
  await using project = await setupTest();

  await mkdir(join(project.clone, '.git', 'hooks'), { recursive: true });

  await writeFile(join(project.clone, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });

  await sanitizeWorkspaceClone(project.clone, 'https://github.com/zgeoff/atc.git');

  const hooks = await readdir(join(project.clone, '.git', 'hooks'));

  expect(hooks).toStrictEqual([]);
});

test('it removes credential files from the work tree and the git directory', async () => {
  await using project = await setupTest();

  await writeFile(join(project.clone, '.git-credentials'), 'https://bob:tok@github.com\n');
  await writeFile(join(project.clone, '.netrc'), 'machine github.com password tok\n');
  await writeFile(join(project.clone, '.git', '.git-credentials'), 'https://bob:tok@github.com\n');
  await sanitizeWorkspaceClone(project.clone, 'https://github.com/zgeoff/atc.git');

  expect(
    [
      join(project.clone, '.git-credentials'),
      join(project.clone, '.netrc'),
      join(project.clone, '.git', '.git-credentials'),
    ].filter((file) => existsSync(file)),
  ).toStrictEqual([]);
});

test('it removes the reflogs that record the clone URL', async () => {
  await using project = await setupTest();

  await sanitizeWorkspaceClone(project.clone, 'https://github.com/zgeoff/atc.git');

  expect(existsSync(join(project.clone, '.git', 'logs'))).toBeFalse();
});

test('it keeps HEAD, the branch, and a readable history', async () => {
  await using project = await setupTest();

  const head = await $`git rev-parse HEAD`.env(project.env).cwd(project.clone).text();

  await $`git config --local credential.helper store`.env(project.env).cwd(project.clone).quiet();

  const sanitized = await sanitizeWorkspaceClone(
    project.clone,
    'https://github.com/zgeoff/atc.git',
  );

  const logged = await $`git log -1 --format=%H`.env(project.env).cwd(project.clone).text();
  const branch = await $`git symbolic-ref --short HEAD`.env(project.env).cwd(project.clone).text();

  expect(sanitized).toStrictEqual({
    ok: true,
    provenance: { repoURL: 'https://github.com/zgeoff/atc.git', sha: head.trim() },
  });

  expect(logged.trim()).toBe(head.trim());
  expect(branch.trim()).toBe('main');
});

test('it refuses a clone whose history no longer reads', async () => {
  await using project = await setupTest();

  await rm(join(project.clone, '.git', 'objects'), { recursive: true, force: true });
  await mkdir(join(project.clone, '.git', 'objects'));

  const sanitized = await sanitizeWorkspaceClone(
    project.clone,
    'https://github.com/zgeoff/atc.git',
  );

  expect(sanitized).toMatchObject({ ok: false, code: 'sanitize_failed' });
});

test('it refuses a URL it cannot read as a repository URL', async () => {
  await using project = await setupTest();

  const sanitized = await sanitizeWorkspaceClone(project.clone, 'not a url');

  expect(sanitized).toMatchObject({ ok: false, code: 'invalid_git_url' });
});
