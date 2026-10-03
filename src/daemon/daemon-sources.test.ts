import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { FixtureDirProvider } from '../../test/fixture-dir-provider';
import { updateEnv } from '../../test/update-env';
import { DaemonClient } from '../client/daemon-client';
import { buildDirsSource } from '../sources/dirs/build-dirs-source';
import { buildGitSource } from '../sources/git/build-git-source';
import { buildGitHubSource } from '../sources/github/build-github-source';
import { startDaemon } from './daemon';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A real daemon with a `local` target, a `box` target that takes a
 * workspace, and a `bare` target whose provider cannot transfer, beside a
 * bare upstream with one commit on main. Principal `alice` may use `box`
 * alone. The daemon offers the directory, GitHub, and git URL sources. The
 * directories hold the root `roots` and a zoxide list of `zoxide-dir` and a
 * directory that does not exist, with `dir` as the home. GitHub runs `gh`
 * from `gh` in the temp tree, which a test writes as a fake that records
 * its argv in `ghArgv`, or leaves absent.
 */
async function setupTest(
  options: { readonly githubOwner?: string; readonly withoutGitHub?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'atc-daemon-repos-'));

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'atc',
    GIT_AUTHOR_EMAIL: 'atc@example.com',
    GIT_COMMITTER_NAME: 'atc',
    GIT_COMMITTER_EMAIL: 'atc@example.com',
  };

  const upstream = join(dir, 'upstream.git');
  const work = join(dir, 'work');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();

  await writeFile(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet --no-gpg-sign -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  await mkdir(join(dir, 'roots', 'proj'), { recursive: true });
  await mkdir(join(dir, 'zoxide-dir'));

  const socketPath = join(dir, 'daemon.sock');
  const clients: DaemonClient[] = [];

  const daemon = await startDaemon({
    gitTransports: ['https', 'ssh', 'file'],
    socketPath,
    reporterSocketPath: join(dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    },
    dbPath: join(dir, 'state.db'),
    statusPath: join(dir, 'status.json'),
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
    principals: new Map([['alice', ['box']]]),
    sources: [
      buildDirsSource({
        roots: [join(dir, 'roots')],
        collectZoxideDirs: () => Promise.resolve([join(dir, 'zoxide-dir'), join(dir, 'gone')]),
        homeDir: dir,
      }),
      ...(options.withoutGitHub === true
        ? []
        : [buildGitHubSource({ bin: join(dir, 'gh'), owner: options.githubOwner ?? null })]),
      buildGitSource(),
    ],
    log: () => {},
  });

  const openClient = async (hello: Readonly<Record<string, unknown>>) => {
    const client = await DaemonClient.open(socketPath);

    clients.push(client);

    await client.sendRequest('daemon.hello', hello);

    return client;
  };

  return {
    dir,
    env,
    upstream,
    work,
    gh: join(dir, 'gh'),
    ghArgv: join(dir, 'gh-argv'),
    client: await openClient({ client: 'atc/test-build' }),
    openClientAs: (principal: string) => openClient({ client: 'atc/test-build', principal }),
    async [Symbol.asyncDispose]() {
      for (const client of clients) {
        client.stop();
      }

      await daemon.stop();

      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it lists the sources it offers in order in agents.list', async () => {
  await using ctx = await setupTest();

  const listed = await ctx.client.sendRequest('agents.list');

  expect(listed['sources']).toStrictEqual([
    { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
    { id: 'github', label: 'GitHub repository', kind: 'git' },
    { id: 'git', label: 'git URL', kind: 'git' },
  ]);
});

test('it lists the spawn history, then the roots, then zoxide, as directories on the daemon host', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.work, cols: 80, rows: 24 });

  const listed = await ctx.client.sendRequest('sources.list', { source: 'dirs' });

  expect(listed).toStrictEqual({
    source: 'dirs',
    scope: null,
    candidates: [
      { label: '~/work', pick: { kind: 'path', dir: ctx.work } },
      { label: '~/roots/proj', pick: { kind: 'path', dir: join(ctx.dir, 'roots', 'proj') } },
      { label: '~/zoxide-dir', pick: { kind: 'path', dir: join(ctx.dir, 'zoxide-dir') } },
    ],
  });
});

test('it lists a principal only the directories spawned on targets it may use', async () => {
  await using ctx = await setupTest();

  const boxDir = join(ctx.dir, 'box-dir');

  await mkdir(boxDir);

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    target: 'local',
    cols: 80,
    rows: 24,
  });

  await ctx.client.sendRequest('session.spawn', { cwd: boxDir, target: 'box', cols: 80, rows: 24 });

  const alice = await ctx.openClientAs('alice');
  const own = await ctx.client.sendRequest('sources.list', { source: 'dirs', target: 'box' });
  const scoped = await alice.sendRequest('sources.list', { source: 'dirs', target: 'box' });

  expect(own['candidates']).toContainEqual({
    label: '~/work',
    pick: { kind: 'path', dir: ctx.work },
  });

  expect(own['candidates']).toContainEqual({
    label: '~/box-dir',
    pick: { kind: 'path', dir: boxDir },
  });

  expect(scoped['candidates']).toContainEqual({
    label: '~/box-dir',
    pick: { kind: 'path', dir: boxDir },
  });

  expect(scoped['candidates']).not.toContainEqual({
    label: '~/work',
    pick: { kind: 'path', dir: ctx.work },
  });
});

test('it lists the configured GitHub owner through gh at the clone URL gh prefers', async () => {
  await using ctx = await setupTest({ githubOwner: 'acme' });

  await writeFile(
    ctx.gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${ctx.ghArgv}'
case "$1" in
  config) echo ssh ;;
  repo) echo '[{"nameWithOwner":"acme/app","description":"the app","isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"},{"nameWithOwner":"acme/web","description":null,"isPrivate":false,"url":"https://github.com/acme/web","sshUrl":"git@github.com:acme/web.git"}]' ;;
esac
`,
    { mode: 0o755 },
  );

  const listed = await ctx.client.sendRequest('sources.list', { source: 'github' });
  const argv = await readFile(ctx.ghArgv, 'utf8');

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
  await using ctx = await setupTest({ githubOwner: 'acme' });

  await writeFile(
    ctx.gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${ctx.ghArgv}'
case "$1" in
  config) exit 1 ;;
  repo) echo '[{"nameWithOwner":"other-org/app","description":"","isPrivate":false,"url":"https://github.com/other-org/app","sshUrl":"git@github.com:other-org/app.git"}]' ;;
esac
`,
    { mode: 0o755 },
  );

  const listed = await ctx.client.sendRequest('sources.list', {
    source: 'github',
    scope: 'other-org',
  });

  const argv = await readFile(ctx.ghArgv, 'utf8');

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
  await using ctx = await setupTest();

  await writeFile(ctx.gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ctx.ghArgv}'\necho '[]'\n`, {
    mode: 0o755,
  });

  const listed = ctx.client.sendRequest('sources.list', {
    source: 'github',
    scope: '--hostname=evil',
  });

  expect(listed).rejects.toMatchObject({ code: 'bad_args' });

  await listed.catch(() => {});

  const ran = await Bun.file(ctx.ghArgv).exists();

  expect(ran).toBeFalse();
});

test('it refuses a GitHub listing on a host without gh as github_unavailable', async () => {
  await using ctx = await setupTest();

  const listed = ctx.client.sendRequest('sources.list', { source: 'github' });

  expect(listed).rejects.toMatchObject({
    code: 'github_unavailable',
    data: { problem: 'not_installed' },
  });
});

test('it refuses a git source listing for a target that cannot take a workspace', async () => {
  await using ctx = await setupTest();

  const listed = ctx.client.sendRequest('sources.list', { source: 'git', target: 'bare' });

  expect(listed).rejects.toMatchObject({ code: 'unsupported_operation' });
});

test('it lists directories for a target that cannot take a workspace', async () => {
  await using ctx = await setupTest();

  const listed = await ctx.client.sendRequest('sources.list', { source: 'dirs', target: 'bare' });

  expect(listed).toMatchObject({ source: 'dirs', scope: null });
});

test('it refuses a principal a source listing for the default target it may not use', async () => {
  await using ctx = await setupTest();

  const alice = await ctx.openClientAs('alice');

  const listed = alice.sendRequest('sources.list', { source: 'dirs' });

  expect(listed).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});

test('it refuses a source the daemon does not offer as unsupported', async () => {
  await using ctx = await setupTest();

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
  await using ctx = await setupTest();

  await writeFile(ctx.gh, '#!/bin/sh\necho ssh\n', { mode: 0o755 });

  const interpreted = await ctx.client.sendRequest('sources.interpret', { source, input });

  expect(interpreted).toStrictEqual(expected);
});

test('it reads a leading ~ in directory input as the daemon home', async () => {
  await using ctx = await setupTest();

  const interpreted = await ctx.client.sendRequest('sources.interpret', {
    source: 'dirs',
    input: '~/work',
  });

  expect(interpreted).toStrictEqual({ kind: 'path', dir: join(ctx.dir, 'work') });
});

test('it probes a git source for the target a principal may use', async () => {
  await using ctx = await setupTest();

  const sha = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const alice = await ctx.openClientAs('alice');

  const probed = await alice.sendRequest('git.probe', {
    url: ctx.upstream,
    ref: 'main',
    target: 'box',
  });

  expect(probed).toStrictEqual({
    url: ctx.upstream,
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha }],
    resolved: { sha, branch: 'main' },
  });
});

test('it refuses a principal a probe for a target it may not use', async () => {
  await using ctx = await setupTest();

  const alice = await ctx.openClientAs('alice');

  const probed = alice.sendRequest('git.probe', { url: ctx.upstream, target: 'local' });

  expect(probed).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});

test('it refuses a probe for a ref the upstream does not have as ref_not_found', async () => {
  await using ctx = await setupTest();

  const probed = ctx.client.sendRequest('git.probe', { url: ctx.upstream, ref: 'nope' });

  expect(probed).rejects.toMatchObject({ code: 'ref_not_found' });
});

test('it refuses a probe of an upstream git cannot read as clone_failed', async () => {
  await using ctx = await setupTest();

  const probed = ctx.client.sendRequest('git.probe', { url: `${ctx.upstream}-missing` });

  expect(probed).rejects.toMatchObject({ code: 'clone_failed', data: undefined });
});

test("it refuses a GitHub probe git cannot read with the repository's other URL form", async () => {
  await using ctx = await setupTest();

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
  await using ctx = await setupTest();

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
  await using ctx = await setupTest({ withoutGitHub: true });

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
