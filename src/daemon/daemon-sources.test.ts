import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDirsSource } from '../sources/dirs/build-dirs-source';
import { buildGitSource } from '../sources/git/build-git-source';
import { buildGitHubSource } from '../sources/github/build-github-source';
import type { SourceProvider } from '../sources/types';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubBin } from '../test-utils/create-stub-bin';
import { FixtureDirProvider } from '../test-utils/fixture-dir-provider';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { updateEnv } from '../test-utils/update-env';
import { LocalPTYProvider } from './local-pty-provider';

interface SourcesTestConfig {
  // The sources the daemon offers, built from the daemon's temp directory.
  readonly sources: (dir: string) => readonly SourceProvider[];

  // The targets each principal may use, or null for none.
  readonly principals: ReadonlyMap<string, readonly string[]> | null;
}

/**
 * A real daemon with a `local` target, a `box` target that takes a
 * workspace, and a `bare` target whose provider cannot transfer, offering
 * the sources and principals the config gives, beside a bare upstream with
 * one commit on main.
 */
async function setupTest(config: SourcesTestConfig) {
  await using stack = new AsyncDisposableStack();

  const git = await createGitFixture({ prefix: 'atc-daemon-sources-git-' });

  stack.use(git);

  const harness = await startTestDaemon({
    prefix: 'atc-daemon-sources-',
    options: (paths) => ({
      // Probes and git sources read the fixture's upstream over file URLs.
      gitTransports: ['https', 'ssh', 'file'],
      adapter: buildMockAgentAdapter(),

      // Spawns and listings name these targets.
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        },
        {
          id: 'box',
          kind: 'fixture-dir',
          options: {},
          identity: 'test:box',
          provider: new FixtureDirProvider(),
        },
        {
          id: 'bare',
          kind: 'fixture-dir',
          options: {},
          identity: 'test:bare',
          provider: new FixtureDirProvider({ lacking: ['transfer'] }),
        },
      ],
      principals: config.principals,
      sources: config.sources(paths.dir),
    }),
  });

  stack.use(harness);

  const owned = stack.move();

  return {
    dir: harness.dir,
    upstream: git.upstream,
    sha: git.sha,
    client: harness.client,
    openClientAs: (principal: string) => harness.openClient({ principal }),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it lists the sources it offers in order in agents.list', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [
      buildDirsSource({ roots: [], collectZoxideDirs: () => Promise.resolve([]), homeDir: dir }),
      buildGitHubSource({ bin: join(dir, 'gh'), owner: null }),
      buildGitSource(),
    ],
    principals: null,
  });

  const listed = await ctx.client.sendRequest('agents.list');

  expect(listed['sources']).toStrictEqual([
    { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
    { id: 'github', label: 'GitHub repository', kind: 'git' },
    { id: 'git', label: 'git URL', kind: 'git' },
  ]);
});

test('it lists the spawn history, then the roots, then zoxide, as directories on the daemon host', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [
      buildDirsSource({
        roots: [join(dir, 'roots')],
        collectZoxideDirs: () => Promise.resolve([join(dir, 'zoxide-dir'), join(dir, 'gone')]),
        homeDir: dir,
      }),
    ],
    principals: null,
  });

  await mkdir(join(ctx.dir, 'work'));
  await mkdir(join(ctx.dir, 'roots', 'proj'), { recursive: true });
  await mkdir(join(ctx.dir, 'zoxide-dir'));

  await ctx.client.sendRequest('session.spawn', { cwd: join(ctx.dir, 'work'), cols: 80, rows: 24 });

  const listed = await ctx.client.sendRequest('sources.list', { source: 'dirs' });

  expect(listed).toStrictEqual({
    source: 'dirs',
    scope: null,
    candidates: [
      { label: '~/work', pick: { kind: 'path', dir: join(ctx.dir, 'work') } },
      { label: '~/roots/proj', pick: { kind: 'path', dir: join(ctx.dir, 'roots', 'proj') } },
      { label: '~/zoxide-dir', pick: { kind: 'path', dir: join(ctx.dir, 'zoxide-dir') } },
    ],
  });
});

test('it lists the owner the directories spawned on every target', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [
      buildDirsSource({ roots: [], collectZoxideDirs: () => Promise.resolve([]), homeDir: dir }),
    ],
    principals: new Map([['alice', ['box']]]),
  });

  await mkdir(join(ctx.dir, 'work'));
  await mkdir(join(ctx.dir, 'box-dir'));

  await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'work'),
    target: 'local',
    cols: 80,
    rows: 24,
  });

  await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box-dir'),
    target: 'box',
    cols: 80,
    rows: 24,
  });

  const listed = await ctx.client.sendRequest('sources.list', { source: 'dirs', target: 'box' });

  expect(listed['candidates']).toIncludeSameMembers([
    { label: '~/work', pick: { kind: 'path', dir: join(ctx.dir, 'work') } },
    { label: '~/box-dir', pick: { kind: 'path', dir: join(ctx.dir, 'box-dir') } },
  ]);
});

test('it lists a principal only the directories spawned on targets it may use', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [
      buildDirsSource({ roots: [], collectZoxideDirs: () => Promise.resolve([]), homeDir: dir }),
    ],
    principals: new Map([['alice', ['box']]]),
  });

  await mkdir(join(ctx.dir, 'work'));
  await mkdir(join(ctx.dir, 'box-dir'));

  await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'work'),
    target: 'local',
    cols: 80,
    rows: 24,
  });

  await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box-dir'),
    target: 'box',
    cols: 80,
    rows: 24,
  });

  const alice = await ctx.openClientAs('alice');
  const listed = await alice.sendRequest('sources.list', { source: 'dirs', target: 'box' });

  expect(listed['candidates']).toStrictEqual([
    { label: '~/box-dir', pick: { kind: 'path', dir: join(ctx.dir, 'box-dir') } },
  ]);
});

test('it lists the configured GitHub owner through gh at the clone URL gh prefers', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [buildGitHubSource({ bin: join(dir, 'gh'), owner: 'acme' })],
    principals: null,
  });

  createStubBin(
    ctx.dir,
    'gh',
    `#!/bin/sh
printf '%s\\n' "$*" >> '${join(ctx.dir, 'gh-argv')}'
case "$1" in
  config) echo ssh ;;
  repo) echo '[{"nameWithOwner":"acme/app","description":"the app","isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"},{"nameWithOwner":"acme/web","description":null,"isPrivate":false,"url":"https://github.com/acme/web","sshUrl":"git@github.com:acme/web.git"}]' ;;
esac
`,
  );

  const listed = await ctx.client.sendRequest('sources.list', { source: 'github' });
  const argv = await readFile(join(ctx.dir, 'gh-argv'), 'utf8');

  expect(listed).toStrictEqual({
    source: 'github',
    scope: 'acme',
    candidates: [
      {
        label: 'acme/app',
        detail: 'private · the app',
        pick: { kind: 'git', url: 'git@github.com:acme/app.git' },
      },
      { label: 'acme/web', pick: { kind: 'git', url: 'git@github.com:acme/web.git' } },
    ],
  });

  expect(argv).toStartWith('repo list acme --limit');
});

test('it lists the scope a request holds over the configured owner, at https URLs by default', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [buildGitHubSource({ bin: join(dir, 'gh'), owner: 'acme' })],
    principals: null,
  });

  createStubBin(
    ctx.dir,
    'gh',
    `#!/bin/sh
printf '%s\\n' "$*" >> '${join(ctx.dir, 'gh-argv')}'
case "$1" in
  config) exit 1 ;;
  repo) echo '[{"nameWithOwner":"other-org/app","description":"","isPrivate":false,"url":"https://github.com/other-org/app","sshUrl":"git@github.com:other-org/app.git"}]' ;;
esac
`,
  );

  const listed = await ctx.client.sendRequest('sources.list', {
    source: 'github',
    scope: 'other-org',
  });

  const argv = await readFile(join(ctx.dir, 'gh-argv'), 'utf8');

  expect(listed).toStrictEqual({
    source: 'github',
    scope: 'other-org',
    candidates: [
      {
        label: 'other-org/app',
        pick: { kind: 'git', url: 'https://github.com/other-org/app.git' },
      },
    ],
  });

  expect(argv).toStartWith('repo list other-org --limit');
});

test('it refuses a GitHub scope gh could read as an option, running no gh', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [buildGitHubSource({ bin: join(dir, 'gh'), owner: null })],
    principals: null,
  });

  createStubBin(
    ctx.dir,
    'gh',
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(ctx.dir, 'gh-argv')}'\necho '[]'\n`,
  );

  const listed = ctx.client.sendRequest('sources.list', {
    source: 'github',
    scope: '--hostname=evil',
  });

  await listed.catch(() => null);

  const ran = await Bun.file(join(ctx.dir, 'gh-argv')).exists();

  expect(listed).rejects.toMatchObject({ code: 'bad_args' });
  expect(ran).toBeFalse();
});

test('it refuses a GitHub listing on a host without gh as github_unavailable', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [buildGitHubSource({ bin: join(dir, 'gh'), owner: null })],
    principals: null,
  });

  const listed = ctx.client.sendRequest('sources.list', { source: 'github' });

  expect(listed).rejects.toMatchObject({
    code: 'github_unavailable',
    data: { problem: 'not_installed' },
  });
});

test('it refuses a git source listing for a target that cannot take a workspace', async () => {
  await using ctx = await setupTest({ sources: () => [buildGitSource()], principals: null });

  const listed = ctx.client.sendRequest('sources.list', { source: 'git', target: 'bare' });

  expect(listed).rejects.toMatchObject({ code: 'unsupported_operation' });
});

test('it lists directories for a target that cannot take a workspace', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [
      buildDirsSource({
        roots: [join(dir, 'roots')],
        collectZoxideDirs: () => Promise.resolve([]),
        homeDir: dir,
      }),
    ],
    principals: null,
  });

  await mkdir(join(ctx.dir, 'roots', 'proj'), { recursive: true });

  const listed = await ctx.client.sendRequest('sources.list', { source: 'dirs', target: 'bare' });

  expect(listed).toStrictEqual({
    source: 'dirs',
    scope: null,
    candidates: [
      { label: '~/roots/proj', pick: { kind: 'path', dir: join(ctx.dir, 'roots', 'proj') } },
    ],
  });
});

test('it refuses a principal a source listing for the default target it may not use', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [
      buildDirsSource({ roots: [], collectZoxideDirs: () => Promise.resolve([]), homeDir: dir }),
    ],
    principals: new Map([['alice', ['box']]]),
  });

  const alice = await ctx.openClientAs('alice');

  const listed = alice.sendRequest('sources.list', { source: 'dirs' });

  expect(listed).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});

test('it refuses a source the daemon does not offer as unsupported', async () => {
  await using ctx = await setupTest({ sources: () => [buildGitSource()], principals: null });

  const listed = ctx.client.sendRequest('sources.interpret', { source: 'gitlab', input: 'x' });

  expect(listed).rejects.toMatchObject({ code: 'unsupported' });
});

test.each([
  ['github', 'acme/', { kind: 'browse', scope: 'acme' }],
  ['github', 'acme/app', { kind: 'git', url: 'git@github.com:acme/app.git' }],
  ['github', 'acme/app.git', { kind: 'git', url: 'git@github.com:acme/app.git' }],
  ['github', 'app', { kind: 'none' }],
  ['git', '/srv/git/app.git', { kind: 'git', url: '/srv/git/app.git' }],
  ['git', 'git@example.com:acme/app.git', { kind: 'git', url: 'git@example.com:acme/app.git' }],
  ['git', 'acme/app', { kind: 'none' }],
  ['dirs', '/srv/work', { kind: 'path', dir: '/srv/work' }],
  ['dirs', 'work', { kind: 'none' }],
] as const)('it reads %s input %p as %p', async (source, input, expected) => {
  await using ctx = await setupTest({
    sources: (dir) => [
      buildDirsSource({ roots: [], collectZoxideDirs: () => Promise.resolve([]), homeDir: dir }),
      buildGitHubSource({ bin: join(dir, 'gh'), owner: null }),
      buildGitSource(),
    ],
    principals: null,
  });

  createStubBin(ctx.dir, 'gh', '#!/bin/sh\necho ssh\n');

  const interpreted = await ctx.client.sendRequest('sources.interpret', { source, input });

  expect(interpreted).toStrictEqual(expected);
});

test('it reads a leading ~ in directory input as the daemon home', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [
      buildDirsSource({ roots: [], collectZoxideDirs: () => Promise.resolve([]), homeDir: dir }),
    ],
    principals: null,
  });

  const interpreted = await ctx.client.sendRequest('sources.interpret', {
    source: 'dirs',
    input: '~/work',
  });

  expect(interpreted).toStrictEqual({ kind: 'path', dir: join(ctx.dir, 'work') });
});

test('it probes a git source for the target a principal may use', async () => {
  await using ctx = await setupTest({
    sources: () => [buildGitSource()],
    principals: new Map([['alice', ['box']]]),
  });

  const alice = await ctx.openClientAs('alice');

  const probed = await alice.sendRequest('git.probe', {
    url: ctx.upstream,
    ref: 'main',
    target: 'box',
  });

  expect(probed).toStrictEqual({
    url: ctx.upstream,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: ctx.sha }],
    resolved: { sha: ctx.sha, branch: 'main' },
  });
});

test('it refuses a principal a probe for a target it may not use', async () => {
  await using ctx = await setupTest({
    sources: () => [buildGitSource()],
    principals: new Map([['alice', ['box']]]),
  });

  const alice = await ctx.openClientAs('alice');

  const probed = alice.sendRequest('git.probe', { url: ctx.upstream, target: 'local' });

  expect(probed).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});

test('it refuses a probe for a ref the upstream does not have as ref_not_found', async () => {
  await using ctx = await setupTest({ sources: () => [buildGitSource()], principals: null });

  const probed = ctx.client.sendRequest('git.probe', { url: ctx.upstream, ref: 'nope' });

  expect(probed).rejects.toMatchObject({ code: 'ref_not_found' });
});

test('it refuses a probe of an upstream git cannot read as clone_failed', async () => {
  await using ctx = await setupTest({ sources: () => [buildGitSource()], principals: null });

  const probed = ctx.client.sendRequest('git.probe', { url: `${ctx.upstream}-missing` });

  expect(probed).rejects.toMatchObject({ code: 'clone_failed', data: undefined });
});

test("it refuses a GitHub probe git cannot read with the repository's other URL form", async () => {
  await using ctx = await setupTest({
    sources: (dir) => [buildGitHubSource({ bin: join(dir, 'gh'), owner: null }), buildGitSource()],
    principals: null,
  });

  // The rewrite sends the https form to a path that does not exist, so no
  // request reaches GitHub.
  await writeFile(
    join(ctx.dir, 'gitconfig'),
    `[url "file://${join(ctx.dir, 'nowhere')}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  updateEnv('GIT_CONFIG_GLOBAL', join(ctx.dir, 'gitconfig'));

  const probed = ctx.client.sendRequest('git.probe', { url: 'https://github.com/acme/app.git' });

  expect(probed).rejects.toMatchObject({
    code: 'clone_failed',
    data: { alternates: ['git@github.com:acme/app.git'] },
  });
});

test('it refuses a probe of the owner/repo shorthand, which only a spawn expands', async () => {
  await using ctx = await setupTest({
    sources: (dir) => [buildGitHubSource({ bin: join(dir, 'gh'), owner: null }), buildGitSource()],
    principals: null,
  });

  // The rewrite sends the expanded form to a path that does not exist, so
  // a probe that expanded the shorthand would fail in git instead.
  await writeFile(
    join(ctx.dir, 'gitconfig'),
    `[url "file://${join(ctx.dir, 'nowhere')}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  updateEnv('GIT_CONFIG_GLOBAL', join(ctx.dir, 'gitconfig'));

  const probed = ctx.client.sendRequest('git.probe', { url: 'acme/app' });

  expect(probed).rejects.toMatchObject({ code: 'invalid_git_url', data: undefined });
});

test('it refuses a GitHub probe with no alternates when the daemon offers no GitHub source', async () => {
  await using ctx = await setupTest({ sources: () => [buildGitSource()], principals: null });

  // The rewrite sends the https form to a path that does not exist, so no
  // request reaches GitHub.
  await writeFile(
    join(ctx.dir, 'gitconfig'),
    `[url "file://${join(ctx.dir, 'nowhere')}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  updateEnv('GIT_CONFIG_GLOBAL', join(ctx.dir, 'gitconfig'));

  const probed = ctx.client.sendRequest('git.probe', { url: 'https://github.com/acme/app.git' });

  expect(probed).rejects.toMatchObject({ code: 'clone_failed', data: undefined });
});
