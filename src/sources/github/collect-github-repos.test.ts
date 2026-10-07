import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildStubGH } from '../../test-utils/build-stub-gh';
import { buildStubSignedOutGH } from '../../test-utils/build-stub-signed-out-gh';
import { createStubBin } from '../../test-utils/create-stub-bin';
import { setupTempDir } from '../../test-utils/setup-temp-dir';
import { collectGitHubRepos } from './collect-github-repos';

// A directory for a stand-in gh and the arguments it records.
function setupTest() {
  return setupTempDir('atc-gh-repos-');
}

test("it lists the requested owner's repositories with the gh clone protocol", async () => {
  using ctx = setupTest();

  const argvFile = join(ctx.dir, 'argv');

  const gh = createStubBin(
    ctx.dir,
    'gh',
    buildStubGH({
      replies: {
        config: { stdout: 'ssh\n' },
        repo: {
          stdout:
            '[{"nameWithOwner":"acme/app","description":null,"isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git","isFork":false}]\n',
        },
      },
      argvFile,
    }),
  );

  const listed = await collectGitHubRepos({ bin: gh, owner: 'acme' });
  const argv = await readFile(argvFile, 'utf8');

  expect({ listed, argv }).toStrictEqual({
    listed: {
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
    },
    argv: 'repo list acme --limit 500 --json nameWithOwner,description,isPrivate,url,sshUrl\nconfig get git_protocol\n',
  });
});

test("it lists the gh account's own repositories without an owner, reading the owner from them", async () => {
  using ctx = setupTest();

  const argvFile = join(ctx.dir, 'argv');

  const gh = createStubBin(
    ctx.dir,
    'gh',
    buildStubGH({
      replies: {
        config: { stdout: 'https\n' },
        repo: {
          stdout:
            '[{"nameWithOwner":"me/dots","description":"dotfiles","isPrivate":false,"url":"https://github.com/me/dots","sshUrl":"git@github.com:me/dots.git"}]\n',
        },
      },
      argvFile,
    }),
  );

  const listed = await collectGitHubRepos({ bin: gh, owner: null });
  const argv = await readFile(argvFile, 'utf8');

  expect({ listed, argv }).toStrictEqual({
    listed: {
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
    },
    argv: 'repo list --limit 500 --json nameWithOwner,description,isPrivate,url,sshUrl\nconfig get git_protocol\n',
  });
});

test('it refuses a host without gh as not installed', async () => {
  using ctx = setupTest();

  const gh = join(ctx.dir, 'gh');

  const listed = await collectGitHubRepos({ bin: gh, owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'not_installed',
    message: `gh is not installed on the daemon host (no '${gh}' on PATH)`,
  });
});

test('it refuses a gh that is signed out as not authenticated', async () => {
  using ctx = setupTest();

  const gh = createStubBin(ctx.dir, 'gh', buildStubSignedOutGH());

  const listed = await collectGitHubRepos({ bin: gh, owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'not_authenticated',
    message:
      'gh is not signed in on the daemon host; run gh auth login there: To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
  });
});

test("it refuses a gh listing that fails with gh's own message", async () => {
  using ctx = setupTest();

  const gh = createStubBin(
    ctx.dir,
    'gh',
    buildStubGH({
      replies: {
        repo: {
          stderr: 'GraphQL: Could not resolve to a User with the login of nobody.\n',
          exitCode: 1,
        },
      },
    }),
  );

  const listed = await collectGitHubRepos({ bin: gh, owner: 'nobody' });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'GraphQL: Could not resolve to a User with the login of nobody.',
  });
});

test('it refuses a gh listing that prints no repository list', async () => {
  using ctx = setupTest();

  const gh = createStubBin(
    ctx.dir,
    'gh',
    buildStubGH({ replies: { repo: { stdout: 'not json\n' } } }),
  );

  const listed = await collectGitHubRepos({ bin: gh, owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh repo list printed no repository list',
  });
});

test('it refuses a gh listing that does not answer within its time limit', async () => {
  using ctx = setupTest();

  const gh = createStubBin(ctx.dir, 'gh', buildStubGH({ replies: { repo: 'hang' } }));

  const listed = await collectGitHubRepos({ bin: gh, owner: null, timeoutMs: 300 });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh did not answer within 0.3 s',
  });
});

test('it refuses a gh listing that fails silently with its exit code', async () => {
  using ctx = setupTest();

  const gh = createStubBin(ctx.dir, 'gh', buildStubGH({ replies: { repo: { exitCode: 3 } } }));

  const listed = await collectGitHubRepos({ bin: gh, owner: 'acme' });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh exited with 3',
  });
});

test("it lists no owner when the gh account's own list is empty", async () => {
  using ctx = setupTest();

  const gh = createStubBin(
    ctx.dir,
    'gh',
    buildStubGH({ replies: { config: { stdout: 'https\n' }, repo: { stdout: '[]\n' } } }),
  );

  const listed = await collectGitHubRepos({ bin: gh, owner: null });

  expect(listed).toStrictEqual({ ok: true, owner: null, repos: [], gitProtocol: 'https' });
});
