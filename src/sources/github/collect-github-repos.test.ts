import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupTempDir } from '../../../test/setup-temp-dir';
import { collectGitHubRepos } from './collect-github-repos';

// A directory for a fake gh script, which records each argv it runs with
// in `argv` beside it.
function setupTest() {
  const tmp = setupTempDir('atc-gh-repos-');

  return {
    gh: join(tmp.dir, 'gh'),
    argvFile: join(tmp.dir, 'argv'),
    [Symbol.asyncDispose]: tmp[Symbol.asyncDispose],
  };
}

test("it lists the requested owner's repositories with the gh clone protocol", async () => {
  await using ctx = setupTest();

  await writeFile(
    ctx.gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${ctx.argvFile}'
case "$1" in
  config) echo ssh ;;
  repo) echo '[{"nameWithOwner":"acme/app","description":null,"isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git","isFork":false}]' ;;
esac
`,
    { mode: 0o755 },
  );

  const listed = await collectGitHubRepos({ bin: ctx.gh, owner: 'acme' });
  const argv = await readFile(ctx.argvFile, 'utf8');

  expect(listed).toStrictEqual({
    ok: true,
    owner: 'acme',
    repos: [
      {
        nameWithOwner: 'acme/app',
        description: '',
        isPrivate: true,
        url: 'https://github.com/acme/app',
        sshUrl: 'git@github.com:acme/app.git',
      },
    ],
    gitProtocol: 'ssh',
  });

  expect(argv).toBe(
    'repo list acme --limit 500 --json nameWithOwner,description,isPrivate,url,sshUrl\nconfig get git_protocol\n',
  );
});

test("it lists the gh account's own repositories without an owner, reading the owner from them", async () => {
  await using ctx = setupTest();

  await writeFile(
    ctx.gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${ctx.argvFile}'
case "$1" in
  config) echo https ;;
  repo) echo '[{"nameWithOwner":"me/dots","description":"dotfiles","isPrivate":false,"url":"https://github.com/me/dots","sshUrl":"git@github.com:me/dots.git"}]' ;;
esac
`,
    { mode: 0o755 },
  );

  const listed = await collectGitHubRepos({ bin: ctx.gh, owner: null });
  const argv = await readFile(ctx.argvFile, 'utf8');

  expect(listed).toStrictEqual({
    ok: true,
    owner: 'me',
    repos: [
      {
        nameWithOwner: 'me/dots',
        description: 'dotfiles',
        isPrivate: false,
        url: 'https://github.com/me/dots',
        sshUrl: 'git@github.com:me/dots.git',
      },
    ],
    gitProtocol: 'https',
  });

  expect(argv).toBe(
    'repo list --limit 500 --json nameWithOwner,description,isPrivate,url,sshUrl\nconfig get git_protocol\n',
  );
});

test('it refuses a host without gh as not installed', async () => {
  await using ctx = setupTest();

  const listed = await collectGitHubRepos({ bin: ctx.gh, owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'not_installed',
    message: `gh is not installed on the daemon host (no '${ctx.gh}' on PATH)`,
  });
});

test('it refuses a gh that is signed out as not authenticated', async () => {
  await using ctx = setupTest();

  await writeFile(
    ctx.gh,
    `#!/bin/sh
echo 'To get started with GitHub CLI, please run:  gh auth login' >&2
exit 4
`,
    { mode: 0o755 },
  );

  const listed = await collectGitHubRepos({ bin: ctx.gh, owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'not_authenticated',
    message:
      'gh is not signed in on the daemon host; run gh auth login there: To get started with GitHub CLI, please run:  gh auth login',
  });
});

test("it refuses a gh listing that fails with gh's own message", async () => {
  await using ctx = setupTest();

  await writeFile(
    ctx.gh,
    `#!/bin/sh
echo 'GraphQL: Could not resolve to a User with the login of nobody.' >&2
exit 1
`,
    { mode: 0o755 },
  );

  const listed = await collectGitHubRepos({ bin: ctx.gh, owner: 'nobody' });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'GraphQL: Could not resolve to a User with the login of nobody.',
  });
});

test('it refuses a gh listing that prints no repository list', async () => {
  await using ctx = setupTest();

  await writeFile(ctx.gh, '#!/bin/sh\necho not json\n', { mode: 0o755 });

  const listed = await collectGitHubRepos({ bin: ctx.gh, owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh repo list printed no repository list',
  });
});

test('it refuses a gh listing that does not answer within its time limit', async () => {
  await using ctx = setupTest();

  await writeFile(ctx.gh, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });

  const started = Date.now();

  const listed = await collectGitHubRepos({ bin: ctx.gh, owner: null, timeoutMs: 300 });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh did not answer within 0.3 s',
  });

  expect(Date.now() - started).toBeLessThan(5000);
});

test('it refuses a gh listing that fails silently with its exit code', async () => {
  await using ctx = setupTest();

  await writeFile(ctx.gh, '#!/bin/sh\nexit 3\n', { mode: 0o755 });

  const listed = await collectGitHubRepos({ bin: ctx.gh, owner: 'acme' });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh exited with 3',
  });
});

test("it lists no owner when the gh account's own list is empty", async () => {
  await using ctx = setupTest();

  await writeFile(
    ctx.gh,
    `#!/bin/sh
case "$1" in
  config) echo https ;;
  repo) echo '[]' ;;
esac
`,
    { mode: 0o755 },
  );

  const listed = await collectGitHubRepos({ bin: ctx.gh, owner: null });

  expect(listed).toStrictEqual({ ok: true, owner: null, repos: [], gitProtocol: 'https' });
});
