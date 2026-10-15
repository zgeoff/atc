import { expect, test } from 'bun:test';
import { buildStubGHCommand } from '@atc/test-utils';
import { buildGitHubSource } from './build-github-source';

test("it lists a scope's repositories as clone URLs of the gh protocol, with privacy and description as detail", async () => {
  const gh = buildStubGHCommand({
    replies: {
      config: { stdout: 'ssh\n' },
      repo: {
        stdout:
          '[{"nameWithOwner":"acme/app","description":"the app","isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"},{"nameWithOwner":"acme/docs","description":null,"isPrivate":false,"url":"https://github.com/acme/docs","sshUrl":"git@github.com:acme/docs.git"}]\n',
      },
    },
  });

  const source = buildGitHubSource({ run: gh.runCommand, bin: 'gh', owner: null });

  const listed = await source.list(
    { scope: 'acme' },
    { target: 'local', collectSpawnDirs: () => Promise.resolve([]) },
  );

  expect(listed).toStrictEqual({
    candidates: [
      {
        label: 'acme/app',
        detail: 'private · the app',
        pick: { kind: 'git', url: 'git@github.com:acme/app.git' },
      },
      { label: 'acme/docs', pick: { kind: 'git', url: 'git@github.com:acme/docs.git' } },
    ],
    scope: 'acme',
  });
});

test('it lists the configured owner as https clone URLs when the request holds no scope', async () => {
  const gh = buildStubGHCommand({
    replies: {
      repo: {
        stdout:
          '[{"nameWithOwner":"acme/app","description":"","isPrivate":false,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"}]\n',
      },
    },
  });

  const source = buildGitHubSource({ run: gh.runCommand, bin: 'gh', owner: 'acme' });

  const listed = await source.list(
    {},
    { target: 'local', collectSpawnDirs: () => Promise.resolve([]) },
  );

  expect(listed).toStrictEqual({
    candidates: [
      { label: 'acme/app', pick: { kind: 'git', url: 'https://github.com/acme/app.git' } },
    ],
    scope: 'acme',
  });

  expect(gh.calls[0]).toStrictEqual([
    'gh',
    'repo',
    'list',
    'acme',
    '--limit',
    '500',
    '--json',
    'nameWithOwner,description,isPrivate,url,sshUrl',
  ]);
});

test('it refuses a scope that is not a GitHub login', () => {
  const gh = buildStubGHCommand({ replies: {} });
  const source = buildGitHubSource({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(
    source.list(
      { scope: 'not a login' },
      { target: 'local', collectSpawnDirs: () => Promise.resolve([]) },
    ),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it refuses a listing gh cannot give as unavailable with the problem', () => {
  const gh = buildStubGHCommand({ replies: { repo: { stderr: 'sign in first', exitCode: 4 } } });
  const source = buildGitHubSource({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(
    source.list({}, { target: 'local', collectSpawnDirs: () => Promise.resolve([]) }),
  ).rejects.toMatchObject({ code: 'github_unavailable', data: { problem: 'not_authenticated' } });
});

test.each([
  ['acme/', 'https', { kind: 'browse', scope: 'acme' }],
  ['acme/app', 'https', { kind: 'git', url: 'https://github.com/acme/app.git' }],
  ['acme/app.git', 'ssh', { kind: 'git', url: 'git@github.com:acme/app.git' }],
  ['github:acme/', 'https', { kind: 'browse', scope: 'acme' }],
  ['github:acme/app', 'https', { kind: 'git', url: 'https://github.com/acme/app.git' }],
  ['github:acme/app', 'ssh', { kind: 'git', url: 'git@github.com:acme/app.git' }],
  ['gitlab:acme/app', 'https', { kind: 'none' }],
  ['app', 'https', { kind: 'none' }],
] as const)(
  'it reads typed %p with a gh that prefers %s as %p',
  async (input, protocol, expected) => {
    const gh = buildStubGHCommand({ replies: { config: { stdout: protocol } } });
    const source = buildGitHubSource({ run: gh.runCommand, bin: 'gh', owner: null });

    const interpretation = await source.interpret(input, {
      target: 'local',
      collectSpawnDirs: () => Promise.resolve([]),
    });

    expect(interpretation).toStrictEqual(expected);
  },
);

test('it finds the other URL form of a GitHub URL as its alternate', () => {
  const gh = buildStubGHCommand({ replies: {} });
  const source = buildGitHubSource({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(source.findAlternateURLs?.('https://github.com/acme/app.git')).toStrictEqual([
    'git@github.com:acme/app.git',
  ]);
});

test('it finds no alternate for a URL off GitHub', () => {
  const gh = buildStubGHCommand({ replies: {} });
  const source = buildGitHubSource({ run: gh.runCommand, bin: 'gh', owner: null });

  expect(source.findAlternateURLs?.('https://example.com/acme/app.git')).toStrictEqual([]);
});
