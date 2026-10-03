import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { FixtureDirProvider } from '../../test/fixture-dir-provider';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from './daemon';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A real daemon with a `local` target, a `box` target that takes a
 * workspace, and a `bare` target whose provider cannot transfer, beside a
 * bare upstream with one commit on main. Principal `alice` may use `box`
 * alone. The daemon runs `gh` from `gh` in the temp tree, which a test
 * writes as a fake that records its argv in `ghArgv`, or leaves absent.
 */
async function setupTest(options: { readonly githubOwner?: string } = {}) {
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

  const socketPath = join(dir, 'daemon.sock');
  const clients: DaemonClient[] = [];

  const daemon = await startDaemon({
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
    ghBin: join(dir, 'gh'),
    githubOwner: options.githubOwner ?? null,
    log: () => {},
  });

  const openClient = async (hello: Readonly<Record<string, unknown>>) => {
    const client = await DaemonClient.open(socketPath);

    clients.push(client);

    await client.sendRequest('daemon.hello', hello);

    return client;
  };

  return {
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

test('it lists the configured GitHub owner through gh when the request holds none', async () => {
  await using ctx = await setupTest({ githubOwner: 'acme' });

  await writeFile(
    ctx.gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${ctx.ghArgv}'
case "$1" in
  config) echo https ;;
  repo) echo '[{"nameWithOwner":"acme/app","description":"the app","isPrivate":false,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"}]' ;;
esac
`,
    { mode: 0o755 },
  );

  const listed = await ctx.client.sendRequest('repos.list', {});
  const argv = await readFile(ctx.ghArgv, 'utf8');

  expect(listed).toStrictEqual({
    owner: 'acme',
    repos: [
      {
        nameWithOwner: 'acme/app',
        description: 'the app',
        isPrivate: false,
        url: 'https://github.com/acme/app',
        sshUrl: 'git@github.com:acme/app.git',
      },
    ],
    gitProtocol: 'https',
  });

  expect(argv).toStartWith('repo list acme --limit');
});

test('it lists the owner a request holds over the configured one', async () => {
  await using ctx = await setupTest({ githubOwner: 'acme' });

  await writeFile(
    ctx.gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${ctx.ghArgv}'
echo '[]'
`,
    { mode: 0o755 },
  );

  const listed = await ctx.client.sendRequest('repos.list', { owner: 'other-org' });
  const argv = await readFile(ctx.ghArgv, 'utf8');

  expect(listed).toMatchObject({ owner: 'other-org', repos: [] });
  expect(argv).toStartWith('repo list other-org --limit');
});

test('it refuses a repository listing on a host without gh as github_unavailable', async () => {
  await using ctx = await setupTest();

  const listed = ctx.client.sendRequest('repos.list', {});

  expect(listed).rejects.toMatchObject({
    code: 'github_unavailable',
    data: { problem: 'not_installed' },
  });
});

test('it refuses a repository listing for a target that cannot take a workspace', async () => {
  await using ctx = await setupTest();

  const listed = ctx.client.sendRequest('repos.list', { target: 'bare' });

  expect(listed).rejects.toMatchObject({ code: 'unsupported_operation' });
});

test('it probes a git source for the target a principal may use', async () => {
  await using ctx = await setupTest();

  const sha = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  const alice = await ctx.openClientAs('alice');

  const probed = await alice.sendRequest('repos.probe', {
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

  const probed = alice.sendRequest('repos.probe', { url: ctx.upstream, target: 'local' });

  expect(probed).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});

test('it refuses a principal a repository listing for the default target it may not use', async () => {
  await using ctx = await setupTest();

  const alice = await ctx.openClientAs('alice');

  const listed = alice.sendRequest('repos.list', {});

  expect(listed).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});

test('it refuses a probe for a ref the upstream does not have as ref_not_found', async () => {
  await using ctx = await setupTest();

  const probed = ctx.client.sendRequest('repos.probe', { url: ctx.upstream, ref: 'nope' });

  expect(probed).rejects.toMatchObject({ code: 'ref_not_found' });
});

test('it refuses a probe of an upstream git cannot read as clone_failed', async () => {
  await using ctx = await setupTest();

  const probed = ctx.client.sendRequest('repos.probe', { url: `${ctx.upstream}-missing` });

  expect(probed).rejects.toMatchObject({ code: 'clone_failed' });
});
