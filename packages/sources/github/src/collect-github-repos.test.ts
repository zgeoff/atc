import { expect, test } from 'bun:test';
import { buildStubGHCommand } from '@atc/test-utils';
import { collectGitHubRepos } from './collect-github-repos';

test("it lists the requested owner's repositories with the gh clone protocol", async () => {
  const gh = buildStubGHCommand({
    replies: {
      config: { stdout: 'ssh\n' },
      repo: {
        stdout:
          '[{"nameWithOwner":"acme/app","description":null,"isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git","isFork":false}]\n',
      },
    },
  });

  const listed = await collectGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: 'acme' });

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

  expect(gh.calls).toStrictEqual([
    [
      'gh',
      'repo',
      'list',
      'acme',
      '--limit',
      '500',
      '--json',
      'nameWithOwner,description,isPrivate,url,sshUrl',
    ],
    ['gh', 'config', 'get', 'git_protocol'],
  ]);
});

test("it lists the gh account's own repositories without an owner, reading the owner from them", async () => {
  const gh = buildStubGHCommand({
    replies: {
      config: { stdout: 'https\n' },
      repo: {
        stdout:
          '[{"nameWithOwner":"me/dots","description":"dotfiles","isPrivate":false,"url":"https://github.com/me/dots","sshUrl":"git@github.com:me/dots.git"}]\n',
      },
    },
  });

  const listed = await collectGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

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

  expect(gh.calls).toStrictEqual([
    [
      'gh',
      'repo',
      'list',
      '--limit',
      '500',
      '--json',
      'nameWithOwner,description,isPrivate,url,sshUrl',
    ],
    ['gh', 'config', 'get', 'git_protocol'],
  ]);
});

test('it refuses a host where gh cannot start as not installed', async () => {
  const gh = buildStubGHCommand({
    replies: { repo: { stderr: 'Executable not found in $PATH: "/opt/gh"', exitCode: 127 } },
  });

  const listed = await collectGitHubRepos({ run: gh.runCommand, bin: '/opt/gh', owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'not_installed',
    message: "gh is not installed on the daemon host (no '/opt/gh' on PATH)",
  });
});

test('it refuses a gh that is signed out as not authenticated', async () => {
  const gh = buildStubGHCommand({
    replies: {
      repo: {
        stderr:
          'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
        exitCode: 4,
      },
    },
  });

  const listed = await collectGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'not_authenticated',
    message:
      'gh is not signed in on the daemon host; run gh auth login there: To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
  });
});

test("it refuses a gh listing that fails with gh's own message", async () => {
  const gh = buildStubGHCommand({
    replies: {
      repo: {
        stderr: 'GraphQL: Could not resolve to a User with the login of nobody.\n',
        exitCode: 1,
      },
    },
  });

  const listed = await collectGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: 'nobody' });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'GraphQL: Could not resolve to a User with the login of nobody.',
  });
});

test('it refuses a gh listing that prints no repository list', async () => {
  const gh = buildStubGHCommand({ replies: { repo: { stdout: 'not json\n' } } });

  const listed = await collectGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh repo list printed no repository list',
  });
});

test('it refuses a gh listing that does not answer within its time limit', async () => {
  const gh = buildStubGHCommand({ replies: { repo: 'hang' } });

  const listed = await collectGitHubRepos({
    run: gh.runCommand,
    bin: 'gh',
    owner: null,
    timeoutMs: 300,
  });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh did not answer within 0.3 s',
  });
});

test('it refuses a gh listing that fails silently with its exit code', async () => {
  const gh = buildStubGHCommand({ replies: { repo: { exitCode: 3 } } });

  const listed = await collectGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: 'acme' });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh exited with 3',
  });
});

test("it lists no owner when the gh account's own list is empty", async () => {
  const gh = buildStubGHCommand({
    replies: { config: { stdout: 'https\n' }, repo: { stdout: '[]\n' } },
  });

  const listed = await collectGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(listed).toStrictEqual({ ok: true, owner: null, repos: [], gitProtocol: 'https' });
});
