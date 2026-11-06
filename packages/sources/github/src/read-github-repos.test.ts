import { expect, test } from 'bun:test';
import { buildStubGHCommand } from '@atc/test-utils';
import { readGitHubRepos } from './read-github-repos';
import { buildMockGitHubAPIRepo } from './test-utils/build-mock-github-api-repo';

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

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: 'acme' });

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

test('it lists every repository the gh account can access without an owner, with no owner', async () => {
  const gh = buildStubGHCommand({
    replies: {
      config: { stdout: 'https\n' },
      api: {
        stdout:
          '[{"full_name":"me/dots","description":"dotfiles","private":false,"html_url":"https://github.com/me/dots","ssh_url":"git@github.com:me/dots.git","fork":false},{"full_name":"acme/app","description":null,"private":true,"html_url":"https://github.com/acme/app","ssh_url":"git@github.com:acme/app.git","fork":false}]\n',
      },
    },
  });

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(listed).toStrictEqual({
    ok: true,
    owner: null,
    repos: [
      {
        nameWithOwner: 'me/dots',
        description: 'dotfiles',
        isPrivate: false,
        url: 'https://github.com/me/dots',
        sshUrl: 'git@github.com:me/dots.git',
      },
      {
        nameWithOwner: 'acme/app',
        description: '',
        isPrivate: true,
        url: 'https://github.com/acme/app',
        sshUrl: 'git@github.com:acme/app.git',
      },
    ],
    gitProtocol: 'https',
  });

  expect(gh.calls).toStrictEqual([
    [
      'gh',
      'api',
      'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=1',
    ],
    ['gh', 'config', 'get', 'git_protocol'],
  ]);
});

test('it reads pages without an owner until a page holds fewer than 100 repositories', async () => {
  const fullPage = {
    stdout: JSON.stringify(Array.from({ length: 100 }, () => buildMockGitHubAPIRepo())),
  };

  const lastPage = {
    stdout: JSON.stringify(Array.from({ length: 37 }, () => buildMockGitHubAPIRepo())),
  };

  const gh = buildStubGHCommand({
    replies: { config: { stdout: 'https\n' }, api: [fullPage, fullPage, lastPage] },
  });

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

  expect({ listed, calls: gh.calls }).toStrictEqual({
    listed: { ok: true, owner: null, repos: expect.toBeArrayOfSize(237), gitProtocol: 'https' },
    calls: [
      ['gh', 'api', expect.stringMatching(/&page=1$/u)],
      ['gh', 'api', expect.stringMatching(/&page=2$/u)],
      ['gh', 'api', expect.stringMatching(/&page=3$/u)],
      ['gh', 'config', 'get', 'git_protocol'],
    ],
  });
});

test('it stops reading pages without an owner at 500 repositories', async () => {
  const fullPage = {
    stdout: JSON.stringify(Array.from({ length: 100 }, () => buildMockGitHubAPIRepo())),
  };

  const gh = buildStubGHCommand({
    replies: {
      config: { stdout: 'https\n' },
      api: [fullPage, fullPage, fullPage, fullPage, fullPage, fullPage],
    },
  });

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

  expect({ listed, calls: gh.calls }).toStrictEqual({
    listed: { ok: true, owner: null, repos: expect.toBeArrayOfSize(500), gitProtocol: 'https' },
    calls: [
      ['gh', 'api', expect.stringMatching(/&page=1$/u)],
      ['gh', 'api', expect.stringMatching(/&page=2$/u)],
      ['gh', 'api', expect.stringMatching(/&page=3$/u)],
      ['gh', 'api', expect.stringMatching(/&page=4$/u)],
      ['gh', 'api', expect.stringMatching(/&page=5$/u)],
      ['gh', 'config', 'get', 'git_protocol'],
    ],
  });
});

test('it refuses a listing without an owner when a later page fails', async () => {
  const gh = buildStubGHCommand({
    replies: {
      api: [
        { stdout: JSON.stringify(Array.from({ length: 100 }, () => buildMockGitHubAPIRepo())) },
        { stderr: 'gh: Server Error (HTTP 502)\n', exitCode: 1 },
      ],
    },
  });

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh: Server Error (HTTP 502)',
  });
});

test('it refuses a host where gh cannot start as not installed', async () => {
  const gh = buildStubGHCommand({
    replies: { api: { stderr: 'Executable not found in $PATH: "/opt/gh"', exitCode: 127 } },
  });

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: '/opt/gh', owner: null });

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
      api: {
        stderr:
          'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
        exitCode: 4,
      },
    },
  });

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

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

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: 'nobody' });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'GraphQL: Could not resolve to a User with the login of nobody.',
  });
});

test('it refuses a gh listing that prints no repository list', async () => {
  const gh = buildStubGHCommand({ replies: { repo: { stdout: 'not json\n' } } });

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: 'acme' });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh repo list printed no repository list',
  });
});

test('it refuses a gh listing that does not answer within its time limit', async () => {
  const gh = buildStubGHCommand({ replies: { api: 'hang' } });

  const listed = await readGitHubRepos({
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

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: 'acme' });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh exited with 3',
  });
});

test('it refuses a listing without an owner that prints no repository list', async () => {
  const gh = buildStubGHCommand({
    replies: { api: { stdout: '{"message":"Bad credentials"}\n' } },
  });

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(listed).toStrictEqual({
    ok: false,
    code: 'github_unavailable',
    problem: 'failed',
    message: 'gh api user/repos printed no repository list',
  });
});

test('it lists no repositories without an owner when the gh account can access none', async () => {
  const gh = buildStubGHCommand({
    replies: { config: { stdout: 'https\n' }, api: { stdout: '[]\n' } },
  });

  const listed = await readGitHubRepos({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(listed).toStrictEqual({ ok: true, owner: null, repos: [], gitProtocol: 'https' });
});
