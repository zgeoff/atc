import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { FixtureDirProvider } from '../../test/fixture-dir-provider';
import { startGitHTTPServer } from '../../test/start-git-http-server';
import { updateEnv } from '../../test/update-env';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { DaemonError } from '../protocol/daemon-error';
import { getRecord } from '../shared/get-record';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { startDaemon } from './daemon';
import type { DaemonHandle } from './daemon';
import type { ExecutionProvider } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';

const idleAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  takesMessages: false,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

// The transports the fixture upstreams are reached over: a local path, and
// smart HTTP on the loopback.
const FIXTURE_TRANSPORTS = ['https', 'ssh', 'http', 'file'];

// The config error of a transport list the daemon cannot use.
const INVALID_TRANSPORTS =
  "workspaces.gitTransports holds 'ext', which atc never allows because it runs a command or reads a descriptor on the daemon host; the daemon runs no git until it is fixed";

// A temp tree holding a bare upstream and a clone of it with one pushed
// commit, and daemons booted on one state directory with a `local` target
// and a `box` target on the provider a test hands in. Fixture git commands
// read neither the host's system nor its global git config. Every line a
// daemon logs is kept.
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'atc-workspace-'));

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  const upstream = join(dir, 'upstream.git');
  const work = join(dir, 'work');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();
  await $`git config user.name atc`.env(env).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(env).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(env).cwd(work).quiet();

  writeFileSync(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const dbPath = join(dir, 'state.db');
  const socketPath = join(dir, 'daemon.sock');
  const daemons: DaemonHandle[] = [];
  const clients: DaemonClient[] = [];
  const logs: string[] = [];

  return {
    dir,
    env,
    upstream,
    work,
    dbPath,
    logs,

    // A daemon on the default transports takes no transports option, as
    // one with no `workspaces.gitTransports` in its config does.
    async boot(box: ExecutionProvider, transports: 'fixture' | 'default' | 'invalid' = 'fixture') {
      const daemon = await startDaemon({
        ...(transports === 'fixture' ? { gitTransports: FIXTURE_TRANSPORTS } : {}),
        ...(transports === 'invalid' ? { gitTransports: { invalid: INVALID_TRANSPORTS } } : {}),
        socketPath,
        reporterSocketPath: join(dir, 'reporter.sock'),
        build: 'atc/test-build',
        adapter: idleAdapter,
        dbPath,
        statusPath: join(dir, 'status.json'),
        targets: [
          {
            id: 'local',
            kind: 'local-pty',
            options: {},
            identity: 'test:local',
            provider: new LocalPTYProvider(),
          },
          { id: 'box', kind: box.kind, options: {}, identity: 'test:box', provider: box },
        ],
        log: (line) => {
          logs.push(line);
        },
      });

      daemons.push(daemon);

      const client = await DaemonClient.open(socketPath);

      clients.push(client);

      await client.sendHello('atc/test-build');

      return { daemon, client };
    },
    async [Symbol.asyncDispose]() {
      for (const client of clients) {
        client.stop();
      }

      for (const daemon of daemons) {
        await daemon.stop();
      }

      await rm(dir, { recursive: true, force: true });
    },
  };
}

// The verify unsets every variable that could point git at another
// repository before it reads the checkout's HEAD and status.
const VERIFY_ENV = [
  'env',
  '-u',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  '-u',
  'GIT_COMMON_DIR',
  '-u',
  'GIT_CONFIG',
  '-u',
  'GIT_CONFIG_COUNT',
  '-u',
  'GIT_CONFIG_PARAMETERS',
  '-u',
  'GIT_DIR',
  '-u',
  'GIT_GRAFT_FILE',
  '-u',
  'GIT_IMPLICIT_WORK_TREE',
  '-u',
  'GIT_INDEX_FILE',
  '-u',
  'GIT_NO_REPLACE_OBJECTS',
  '-u',
  'GIT_OBJECT_DIRECTORY',
  '-u',
  'GIT_PREFIX',
  '-u',
  'GIT_REPLACE_REF_BASE',
  '-u',
  'GIT_SHALLOW_FILE',
  '-u',
  'GIT_WORK_TREE',
];

const VERIFY_ARGV = [...VERIFY_ENV, 'git', 'rev-parse', '--verify', 'HEAD^{commit}'];

const STATUS_ARGV = [
  ...VERIFY_ENV,
  'git',
  '-c',
  'core.fsmonitor=false',
  'status',
  '--porcelain',
  '--untracked-files=no',
];

test('it materializes a path source at its pushed HEAD on the target and verifies it there', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);
  const sha = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  const dest = join(ctx.dir, 'box', 'ws');
  const before = Date.now();

  const spawned = await booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(dest).text();

  const session = getRecord(spawned, 'session');

  expect(session).toMatchObject({ cwd: dest, locator: { targetID: 'box' } });

  const workspace = getRecord(session, 'workspace');

  expect(workspace).toContainAllKeys(['repoURL', 'sha', 'ref', 'materializedAt']);
  expect(workspace).toMatchObject({ repoURL: ctx.upstream, sha: sha.trim(), ref: 'main' });
  expect(workspace['materializedAt']).toBeWithin(before, Date.now() + 1);
  expect(head.trim()).toBe(sha.trim());
  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('hello\n');
  expect(spawned['warnings']).toBeUndefined();

  expect(box.calls).toMatchObject([
    { op: 'run', argv: ['sh', '-c', expect.any(String), 'sh', dest], cwd: '/' },
    { op: 'run', argv: ['mkdir', '-p', '--', join(ctx.dir, 'box')], cwd: '/' },
    { op: 'run', argv: ['mkdir', '--', dest], cwd: '/' },
    { op: 'transfer', dir: dest },
    { op: 'run', argv: VERIFY_ARGV, cwd: dest },
    { op: 'run', argv: STATUS_ARGV, cwd: dest },
  ]);
});

test('it verifies the target checkout itself when the daemon env points git at another repository', async () => {
  await using ctx = await setupTest();

  // A git hook in a linked worktree exports GIT_DIR, and a daemon started
  // from one inherits it.
  const decoy = join(ctx.dir, 'decoy');

  await $`git init --quiet --template= --initial-branch=main ${decoy}`.env(ctx.env).quiet();

  await $`git -c user.name=atc -c user.email=atc@example.com commit --quiet --allow-empty -m decoy`
    .env(ctx.env)
    .cwd(decoy)
    .quiet();

  updateEnv('GIT_DIR', join(decoy, '.git'));

  const booted = await ctx.boot(new FixtureDirProvider());
  const sha = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  const spawned = await booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(getRecord(getRecord(spawned, 'session'), 'workspace')).toMatchObject({
    sha: sha.trim(),
  });
});

test('it fails the spawn when the target checkout lacks a tracked file, and removes it', async () => {
  await using ctx = await setupTest();

  const sha = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  // The unpack on the host leaves one tracked file out.
  const box = new FixtureDirProvider({
    afterTransfer: async (dir) => {
      await rm(join(dir, 'README.md'));
    },
  });

  const booted = await ctx.boot(box);

  const dest = join(ctx.dir, 'box', 'ws');

  const refused = await booted.client
    .sendRequest('session.spawn', {
      cwd: dest,
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  if (!(refused instanceof DaemonError)) {
    throw new TypeError('the spawn over a checkout missing a tracked file was not refused');
  }

  expect(refused.code).toBe('workspace_mismatch');
  expect(refused.message).toInclude('README.md');

  expect(refused.data).toStrictEqual({
    phase: 'verifying',
    expected: sha.trim(),
    actual: sha.trim(),
  });

  const listed = await booted.client.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
  expect(existsSync(dest)).toBeFalse();
});

test('it removes only the directory it created when a symlink in the requested path changes before a rollback', async () => {
  await using ctx = await setupTest();

  const safe = join(ctx.dir, 'safe');
  const busy = join(ctx.dir, 'busy');
  const alias = join(ctx.dir, 'alias');

  mkdirSync(safe);
  mkdirSync(join(busy, 'ws', 'inner'), { recursive: true });
  writeFileSync(join(busy, 'ws', 'inner', 'keep.txt'), 'kept\n');
  symlinkSync(safe, alias);

  // The unpack leaves a tracked file out, and the requested path's symlink
  // moves to another directory before the rollback removes the checkout.
  const box = new FixtureDirProvider({
    afterTransfer: async (dir) => {
      await rm(join(dir, 'README.md'));

      unlinkSync(alias);
      symlinkSync(busy, alias);
    },
  });

  const booted = await ctx.boot(box);

  const refused = await booted.client
    .sendRequest('session.spawn', {
      cwd: join(alias, 'ws'),
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    })
    .catch((error: unknown) => error);

  expect<Record<string, unknown>>({
    refused,
    kept: readFileSync(join(busy, 'ws', 'inner', 'keep.txt'), 'utf8'),
    created: existsSync(join(safe, 'ws')),
  }).toMatchObject({
    refused: { code: 'workspace_mismatch' },
    kept: 'kept\n',
    created: false,
  });
});

test('it records a ready workspace and lists it again on the session after a restart', async () => {
  await using ctx = await setupTest();

  const first = await ctx.boot(new FixtureDirProvider());

  const dest = join(ctx.dir, 'box', 'ws');

  const spawned = await first.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  const workspace = getRecord(spawned, 'session')['workspace'];

  await first.daemon.stop();

  const second = await ctx.boot(new FixtureDirProvider());
  const restored = await second.client.sendRequest('fleet.list');

  expect(restored).toStrictEqual({
    fleet: [expect.objectContaining({ cwd: dest, target: 'box', workspace })],
  });
});

test('it refuses a path source whose HEAD was never pushed, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  writeFileSync(join(ctx.work, 'README.md'), 'unpushed\n');

  await $`git commit --quiet -am unpushed`.env(ctx.env).cwd(ctx.work).quiet();

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'unpushed_head', data: { phase: 'resolving' } });

  await spawn.catch(() => null);

  const listed = await booted.client.sendRequest('session.list');

  expect(box.calls).toStrictEqual([]);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a path source with uncommitted changes as workspace_dirty when dirt is refused', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  writeFileSync(join(ctx.work, 'README.md'), 'edited\n');

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work, allowDirty: 'refuse' },
  });

  expect(spawn).rejects.toMatchObject({ code: 'workspace_dirty' });

  await spawn.catch(() => null);

  expect(box.calls).toStrictEqual([]);
});

test('it materializes the committed HEAD of a dirty path source and leaves its changes behind', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());
  const sha = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  const dest = join(ctx.dir, 'box', 'ws');

  writeFileSync(join(ctx.work, 'README.md'), 'edited\n');
  writeFileSync(join(ctx.work, 'scratch.txt'), 'untracked\n');

  const before = await $`git status --porcelain`.env(ctx.env).cwd(ctx.work).text();

  const spawned = await booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  const session = getRecord(spawned, 'session');

  const after = await $`git status --porcelain`.env(ctx.env).cwd(ctx.work).text();
  const cloned = await $`git rev-parse HEAD`.env(ctx.env).cwd(dest).text();

  expect(session['workspace']).toMatchObject({ sha: sha.trim() });
  expect(cloned).toBe(sha);

  expect(spawned['warnings']).toStrictEqual([
    `cloned commit ${sha.slice(0, 12)}; left 2 uncommitted or untracked paths behind in ${ctx.work}`,
  ]);

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('hello\n');
  expect(existsSync(join(dest, 'scratch.txt'))).toBeFalse();
  expect(after).toBe(before);
  expect(readFileSync(join(ctx.work, 'README.md'), 'utf8')).toBe('edited\n');
  expect(readFileSync(join(ctx.work, 'scratch.txt'), 'utf8')).toBe('untracked\n');
});

test('it materializes the committed HEAD of a dirty path source when dirt is allowed with a warning', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());
  const sha = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  const dest = join(ctx.dir, 'box', 'ws');

  writeFileSync(join(ctx.work, 'scratch.txt'), 'untracked\n');

  const spawned = await booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work, allowDirty: 'warn' },
  });

  expect(getRecord(spawned, 'session')['workspace']).toMatchObject({ sha: sha.trim() });

  expect(spawned['warnings']).toStrictEqual([
    `cloned commit ${sha.slice(0, 12)}; left 1 uncommitted or untracked path behind in ${ctx.work}`,
  ]);

  expect(existsSync(join(dest, 'scratch.txt'))).toBeFalse();
});

test('it refuses a dirty path source whose HEAD was never pushed, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  writeFileSync(join(ctx.work, 'README.md'), 'unpushed\n');

  await $`git commit --quiet -am unpushed`.env(ctx.env).cwd(ctx.work).quiet();

  writeFileSync(join(ctx.work, 'scratch.txt'), 'untracked\n');

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'unpushed_head', data: { phase: 'resolving' } });

  await spawn.catch(() => null);

  expect(box.calls).toStrictEqual([]);
});

test('it refuses a path source that uses submodules, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);
  const sha = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  await $`git update-index --add --cacheinfo 160000,${sha.trim()},vendor/lib`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await $`git commit --quiet -m submodule`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'has_submodules' });

  await spawn.catch(() => null);

  expect(box.calls).toStrictEqual([]);
});

test('it refuses a git source that tracks LFS paths, transferring nothing and leaving no directory', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  const dest = join(ctx.dir, 'box', 'ws');

  writeFileSync(join(ctx.work, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  writeFileSync(join(ctx.work, 'model.bin'), 'version https://git-lfs.github.com/spec/v1\n');

  await $`git add .gitattributes model.bin`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet -m lfs`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main' },
  });

  expect(spawn).rejects.toMatchObject({ code: 'lfs_unsupported', data: { phase: 'cloning' } });

  await spawn.catch(() => null);

  expect(box.calls.filter((call) => call.op === 'transfer')).toStrictEqual([]);
  expect(existsSync(dest)).toBeFalse();
});

test('it refuses a path source whose git config rewrites its origin into a URL with a token', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  await $`git config ${`url.https://x-access-token:tok-1@example.com/.insteadOf`} ${ctx.upstream}`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'credential_in_url' });

  await spawn.catch(() => null);

  expect(box.calls).toStrictEqual([]);
});

test('it refuses a git source whose URL carries a token', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'git', url: 'https://x-access-token:tok-1@example.com/r.git', ref: 'main' },
  });

  expect(spawn).rejects.toMatchObject({ code: 'credential_in_url' });

  await spawn.catch(() => null);

  expect(box.calls).toStrictEqual([]);
});

test('it keeps a credential out of every row, provenance, log line, and refusal', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());

  updateEnv('ATC_TEST_WORKSPACE_TOKEN', 'tok-7d1e5a');

  const credentialRef = { kind: 'env', name: 'ATC_TEST_WORKSPACE_TOKEN' };

  const spawned = await booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main', credentialRef },
  });

  // A ref spelled as the token makes git's own refusal carry it.
  const refused = await booted.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws-2'),
      target: 'box',
      workspace: { kind: 'git', url: ctx.upstream, ref: 'tok-7d1e5a', credentialRef },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const fleet = await booted.client.sendRequest('fleet.list');

  const state = readdirSync(ctx.dir).filter((name) => name.startsWith('state.db'));
  const stored = state.map((name) => readFileSync(join(ctx.dir, name)).toString('latin1'));

  if (!(refused instanceof DaemonError)) {
    throw new TypeError('the spawn under a missing ref was not refused');
  }

  expect(refused.code).toBe('ref_not_found');
  expect(refused.message).toInclude('[credential]');
  expect(refused.message).not.toInclude('tok-7d1e5a');
  expect(refused.data).toStrictEqual({ phase: 'cloning' });
  expect(state).not.toBeEmpty();
  expect(stored).toSatisfyAll((bytes: string) => !bytes.includes('tok-7d1e5a'));
  expect(JSON.stringify(spawned)).not.toInclude('tok-7d1e5a');
  expect(JSON.stringify(fleet)).not.toInclude('tok-7d1e5a');
  expect(ctx.logs).not.toBeEmpty();
  expect(ctx.logs).toSatisfyAll((line: string) => !line.includes('tok-7d1e5a'));
});

test('it clones with the workspace credential and starts the harness without it or the askpass context', async () => {
  await using ctx = await setupTest();

  const server = startGitHTTPServer(ctx.dir, ctx.env);

  onTestFinished(async () => {
    await server.stop();
  });

  // The askpass variables stand in for a daemon whose own environment holds
  // them; the credential variable is the one the spawn names.
  updateEnv('ATC_TEST_WORKSPACE_CRED', 'fixture-not-a-secret');
  updateEnv('GIT_ASKPASS', '/fixture/askpass');
  updateEnv('ATC_GIT_ASKPASS_SECRET', 'fixture-not-a-secret');

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  const dest = join(ctx.dir, 'box', 'ws');
  const url = `${server.url}upstream.git`;

  await booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: {
      kind: 'git',
      url,
      ref: 'main',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_CRED' },
    },
  });

  const [harness] = box.harnesses;

  if (harness === undefined) {
    throw new Error('the spawn started no harness');
  }

  const tree = await $`grep -rl fixture-not-a-secret ${dest}`.nothrow().quiet().text();
  const origin = await $`git config --get remote.origin.url`.env(ctx.env).cwd(dest).text();

  expect(server.authorizations).not.toBeEmpty();

  expect(server.authorizations).toSatisfyAll(
    (header: string) =>
      header === `Basic ${Buffer.from('x-access-token:fixture-not-a-secret').toString('base64')}`,
  );

  expect(harness.env).not.toContainAnyKeys([
    'ATC_TEST_WORKSPACE_CRED',
    'GIT_ASKPASS',
    'ATC_GIT_ASKPASS_SECRET',
  ]);

  expect(harness.env).toContainKey('ATC_SESSION_ID');
  expect(tree).toBe('');
  expect(origin.trim()).toBe(url);
});

test('it starts a revived harness after a restart without the workspace credential', async () => {
  await using ctx = await setupTest();

  const seeded = await StateStore.open(ctx.dbPath);

  const dest = join(ctx.dir, 'box', 'ws');

  await seeded.createMaterialization(
    {
      sessionID: toSessionID('s-ws'),
      target: 'box',
      dir: dest,
      sourceKind: 'git',
      withheldEnv: ['ATC_TEST_WORKSPACE_CRED', 'GIT_ASKPASS', 'ATC_GIT_ASKPASS_SECRET'],
    },
    1000,
  );

  await seeded.updateMaterialization(
    toSessionID('s-ws'),
    { phase: 'ready', repoURL: ctx.upstream, sha: 'a'.repeat(40), materializedAt: 1000 },
    1000,
  );

  await seeded.writeFleet([
    {
      sessionID: toSessionID('s-ws'),
      name: 'ws',
      cwd: dest,
      agentSessionID: toAgentSessionID('agent-ws'),
      agent: 'claude',
      target: 'box',
      targetIdentity: 'test:box',
    },
  ]);

  await seeded.stop();

  updateEnv('ATC_TEST_WORKSPACE_CRED', 'fixture-not-a-secret');
  mkdirSync(dest, { recursive: true });

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  await booted.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const harness = await waitFor(() => {
    const [revived] = box.harnesses;

    if (revived === undefined) {
      throw new Error('no harness revived yet');
    }

    return revived;
  });

  expect(harness.cwd).toBe(dest);
  expect(harness.env).not.toContainKey('ATC_TEST_WORKSPACE_CRED');
});

test('it fails the spawn when the target checkout is not at the pinned commit, and removes it', async () => {
  await using ctx = await setupTest();

  const parent = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  writeFileSync(join(ctx.work, 'README.md'), 'second\n');

  await $`git commit --quiet -am second`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const pinned = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  // The host's checkout lands on another commit than the one sent.
  const box = new FixtureDirProvider({
    afterTransfer: async (dir) => {
      await Bun.write(join(dir, '.git', 'HEAD'), parent);
    },
  });

  const booted = await ctx.boot(box);

  const dest = join(ctx.dir, 'box', 'ws');

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, sha: pinned.trim() },
  });

  expect(spawn).rejects.toMatchObject({
    code: 'workspace_mismatch',
    data: { phase: 'verifying', expected: pinned.trim(), actual: parent.trim() },
  });

  await spawn.catch(() => null);

  const listed = await booted.client.sendRequest('session.list');

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT phase, error_code, sha FROM workspace_materialization').all();

  expect(listed).toStrictEqual({ sessions: [] });
  expect(existsSync(dest)).toBeFalse();

  expect(rows).toStrictEqual([
    { phase: 'failed', error_code: 'workspace_mismatch', sha: pinned.trim() },
  ]);
});

test.each([['transfer'], ['run']] as const)(
  'it refuses a workspace on a target whose provider cannot %s before any git command runs',
  async (capability) => {
    await using ctx = await setupTest();

    const box = new FixtureDirProvider({ lacking: [capability] });

    const booted = await ctx.boot(box);

    // A dirty tree whose dirt is refused fails as workspace_dirty once
    // resolution runs.
    writeFileSync(join(ctx.work, 'README.md'), 'edited\n');

    const spawn = booted.client.sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      target: 'box',
      workspace: { kind: 'path', path: ctx.work, allowDirty: 'refuse' },
    });

    expect(spawn).rejects.toMatchObject({
      code: 'unsupported_operation',
      data: { provider: 'fixture-dir', capability },
    });

    await spawn.catch(() => null);

    using db = new Database(ctx.dbPath, { readonly: true });

    const rows = db.query('SELECT * FROM workspace_materialization').all();

    expect(box.calls).toStrictEqual([]);
    expect(rows).toStrictEqual([]);
  },
);

test('it fails a materialization that a restart interrupts and lists no session for it', async () => {
  await using ctx = await setupTest();

  const held = Promise.withResolvers<undefined>();

  onTestFinished(() => {
    held.resolve(undefined);
  });

  const box = new FixtureDirProvider({ afterTransfer: () => held.promise });

  const first = await ctx.boot(box);

  const spawn = first.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await waitFor(() => {
    expect(box.calls).toPartiallyContain({ op: 'transfer' });
  });

  await first.daemon.stop();
  await spawn.catch(() => null);

  const second = await ctx.boot(new FixtureDirProvider());
  const listed = await second.client.sendRequest('session.list');

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT phase, error_code FROM workspace_materialization').all();

  held.resolve(undefined);

  // The stopped daemon's materialization resumes into its closed store and
  // fails there.
  await waitFor(() => {
    expect(ctx.logs).toSatisfyAny((line: string) => line.includes('failed while transferring'));
  });

  expect(listed).toStrictEqual({ sessions: [] });
  expect(rows).toStrictEqual([{ phase: 'failed', error_code: 'workspace_interrupted' }]);
});

test('it refuses to materialize into a directory that already exists and leaves it as it was', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  const dest = join(ctx.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'mine.txt'), 'keep\n');

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists', data: { dir: dest } });

  await spawn.catch(() => null);

  expect(box.calls.filter((call) => call.op === 'transfer')).toStrictEqual([]);
  expect(readdirSync(dest)).toStrictEqual(['mine.txt']);
});

test('it removes the checkout it created and keeps the files beside it when its harness fails to start, so a retry into the same directory spawns', async () => {
  await using ctx = await setupTest();

  const host = new FixtureDirProvider();

  const refusals = [new DaemonError('host_unavailable', 'the harness could not start')];

  // A provider whose first harness start throws, as a refused launch does.
  const box: ExecutionProvider = {
    kind: host.kind,
    remote: host.remote,
    capabilities: host.capabilities,
    prepareHost: host.prepareHost,
    spawnHarness: (spec) => {
      const refusal = refusals.shift();

      if (refusal !== undefined) {
        throw refusal;
      }

      return host.spawnHarness(spec);
    },
    transferArchive: host.transferArchive,
    runCommand: host.runCommand,
    suspendHost: host.suspendHost,
    destroyHost: host.destroyHost,
    dispose: host.dispose,
  };

  const booted = await ctx.boot(box);

  const dest = join(ctx.dir, 'box', 'ws');

  mkdirSync(join(ctx.dir, 'box'));
  writeFileSync(join(ctx.dir, 'box', 'beside.txt'), 'kept\n');

  const params = { cwd: dest, target: 'box', workspace: { kind: 'path', path: ctx.work } };
  const spawn = booted.client.sendRequest('session.spawn', params);

  expect(spawn).rejects.toMatchObject({ code: 'host_unavailable' });

  await spawn.catch(() => null);

  const left = readdirSync(join(ctx.dir, 'box'));

  const retried = await booted.client.sendRequest('session.spawn', params);

  expect<Record<string, unknown>>({
    left,
    beside: readFileSync(join(ctx.dir, 'box', 'beside.txt'), 'utf8'),
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    alive: getRecord(retried, 'session')['alive'],
  }).toStrictEqual({
    left: ['beside.txt'],
    beside: 'kept\n',
    readme: 'hello\n',
    alive: true,
  });
});

test('it refuses a workspace spawn whose cwd is relative before anything runs', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: 'ws',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });

  await spawn.catch(() => null);

  expect(box.calls).toStrictEqual([]);
});

test('it refuses a directory outside git as the workspace of a target off the daemon host', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box);

  const plain = join(ctx.dir, 'plain');

  mkdirSync(plain);

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: plain },
  });

  expect(spawn).rejects.toMatchObject({ code: 'not_a_git_repo' });

  await spawn.catch(() => null);

  expect(box.calls).toStrictEqual([]);
});

test('it runs a local session in a directory outside git as it stands', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());

  const plain = join(ctx.dir, 'plain');

  mkdirSync(plain);

  const spawned = await booted.client.sendRequest('session.spawn', {
    cwd: plain,
    target: 'local',
    workspace: { kind: 'path', path: plain },
  });

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT * FROM workspace_materialization').all();

  expect(getRecord(spawned, 'session')).not.toContainKey('workspace');
  expect(getRecord(spawned, 'session')['cwd']).toBe(plain);
  expect(rows).toStrictEqual([]);
});

test('it refuses to run a local repository in place when git cannot read its config', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());

  writeFileSync(join(ctx.work, '.git', 'config'), '[[[\n');

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    target: 'local',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'unreadable_tree', data: { phase: 'resolving' } });

  await spawn.catch(() => null);
});

test('it refuses to run a local repository in place when git does not trust its owner', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());

  // git's own switch for treating every repository as another user's, with
  // the host's system and global config kept out, since a host that lists
  // the repository under safe.directory trusts it whatever its owner.
  updateEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1');
  updateEnv('GIT_CONFIG_NOSYSTEM', '1');
  updateEnv('GIT_CONFIG_GLOBAL', '/dev/null');

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    target: 'local',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'unreadable_tree', data: { phase: 'resolving' } });

  await spawn.catch(() => null);
});

test('it runs a local spawn without a workspace in a repository git cannot read', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());

  writeFileSync(join(ctx.work, '.git', 'config'), '[[[\n');

  const spawned = await booted.client.sendRequest('session.spawn', { cwd: ctx.work });

  expect(getRecord(spawned, 'session')).toMatchObject({
    cwd: ctx.work,
    locator: { targetID: 'local' },
  });
});

test('it refuses a local directory outside git as the workspace of a spawn elsewhere', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());

  const plain = join(ctx.dir, 'plain');

  mkdirSync(plain);

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'elsewhere'),
    target: 'local',
    workspace: { kind: 'path', path: plain },
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args', data: { phase: 'resolving' } });

  await spawn.catch(() => null);

  expect(existsSync(join(ctx.dir, 'elsewhere'))).toBeFalse();
});

test('it materializes a git source on the local target like on any other', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());
  const sha = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  const dest = join(ctx.dir, 'local', 'ws');

  const spawned = await booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'local',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main' },
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(dest).text();

  expect(spawned).toMatchObject({
    session: { cwd: dest, workspace: { repoURL: ctx.upstream, sha: sha.trim(), ref: 'main' } },
  });

  expect(head.trim()).toBe(sha.trim());
});

test('it runs a local spawn without a workspace in its directory as it stands', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());
  const spawned = await booted.client.sendRequest('session.spawn', { cwd: ctx.work });

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT * FROM workspace_materialization').all();

  expect(getRecord(spawned, 'session')).not.toContainKey('workspace');

  expect(getRecord(spawned, 'session')).toMatchObject({
    cwd: ctx.work,
    locator: { targetID: 'local' },
  });

  expect(rows).toStrictEqual([]);
});

test('it checks out the sha of a git source that holds both on the branch its ref names', async () => {
  await using ctx = await setupTest();

  const booted = await ctx.boot(new FixtureDirProvider());

  const pinned = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  writeFileSync(join(ctx.work, 'later.txt'), 'later\n');

  await $`git add later.txt`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet -m later`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const dest = join(ctx.dir, 'box', 'ws');

  const spawned = await booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main', sha: pinned },
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(dest).text();
  const branch = await $`git symbolic-ref HEAD`.env(ctx.env).cwd(dest).nothrow().text();

  expect(getRecord(getRecord(spawned, 'session'), 'workspace')).toMatchObject({
    sha: pinned,
    ref: 'main',
  });

  expect(head.trim()).toBe(pinned);
  expect(branch.trim()).toBe('refs/heads/main');
  expect(existsSync(join(dest, 'later.txt'))).toBeFalse();
});

test('it refuses a git source on a local transport before it runs git, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box, 'default');

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  expect(spawn).rejects.toMatchObject({ code: 'invalid_git_url' });
  expect(spawn).rejects.toThrow("git transport 'file' is not allowed");

  await spawn.catch(() => null);

  expect(box.calls).toStrictEqual([]);
});

test('it refuses a path source whose origin is a local repository, in git, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box, 'default');

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toThrow("transport 'file' not allowed");

  await spawn.catch(() => null);

  expect(box.calls).not.toContainEqual(expect.objectContaining({ op: 'transfer' }));
});

test('it holds a probe and a spawn to the configured transports whatever transports they carry', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box, 'default');

  const probe = await booted.client
    .sendRequest('git.probe', {
      url: `file://${ctx.upstream}`,
      target: 'box',
      transports: ['file'],
      gitTransports: ['file'],
    })
    .catch((error: unknown) => error);

  const spawn = await booted.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      target: 'box',
      gitTransports: ['file'],
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    })
    .catch((error: unknown) => error);

  const widened = await booted.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      target: 'box',
      workspace: {
        kind: 'git',
        url: `file://${ctx.upstream}`,
        ref: 'main',
        gitTransports: ['file'],
      },
    })
    .catch((error: unknown) => error);

  expect(probe).toMatchObject({ code: 'invalid_git_url' });
  expect(spawn).toMatchObject({ code: 'invalid_git_url' });
  expect(widened).toMatchObject({ code: 'bad_args' });
  expect(box.calls).toStrictEqual([]);
});

test('it holds git to the configured transports whatever the daemon environment allows', async () => {
  await using ctx = await setupTest();

  updateEnv('GIT_ALLOW_PROTOCOL', 'https:ssh:file');
  updateEnv('ATC_GIT_ALLOW_PROTOCOL', 'https:ssh:file');

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box, 'default');

  const spawn = booted.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toThrow("transport 'file' not allowed");

  await spawn.catch(() => null);

  expect(box.calls).not.toContainEqual(expect.objectContaining({ op: 'transfer' }));
});

test('it materializes a spawn from the owner/repo shorthand at its GitHub https URL', async () => {
  await using ctx = await setupTest();

  // The rewrite sends the expanded URL to the fixture upstream, so no
  // request reaches GitHub.
  writeFileSync(
    join(ctx.dir, 'gitconfig'),
    `[url "file://${ctx.dir}/"]\n\tinsteadOf = https://github.com/acme/\n`,
  );

  updateEnv('GIT_CONFIG_GLOBAL', join(ctx.dir, 'gitconfig'));

  const booted = await ctx.boot(new FixtureDirProvider());

  const dest = join(ctx.dir, 'local', 'ws');

  const spawned = await booted.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'local',
    workspace: { kind: 'git', url: 'acme/upstream', ref: 'main' },
  });

  expect(spawned).toMatchObject({
    session: { workspace: { repoURL: 'https://github.com/acme/upstream.git', ref: 'main' } },
  });
});

test('it refuses a probe, a git spawn, and a checkout spawn under an invalid transport list before any git runs', async () => {
  await using ctx = await setupTest();

  const box = new FixtureDirProvider();

  const booted = await ctx.boot(box, 'invalid');

  // A git first on the PATH records each run, so a refusal that runs git
  // leaves the record behind.
  writeFileSync(
    join(ctx.dir, 'git'),
    `#!/bin/sh\necho "$@" >> '${join(ctx.dir, 'git-ran')}'\nexit 1\n`,
    { mode: 0o755 },
  );

  updateEnv('PATH', `${ctx.dir}:${process.env['PATH'] ?? ''}`);

  const probe = await booted.client
    .sendRequest('git.probe', { url: 'https://example.com/app.git', target: 'box' })
    .catch((error: unknown) => error);

  const spawn = await booted.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      target: 'box',
      workspace: { kind: 'git', url: 'https://example.com/app.git', ref: 'main' },
    })
    .catch((error: unknown) => error);

  const pathSpawn = await booted.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws-path'),
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    })
    .catch((error: unknown) => error);

  const refusal = {
    code: 'git_transports_invalid',
    message: `workspaces.gitTransports in config.json is invalid, so the daemon runs no git: ${INVALID_TRANSPORTS}`,
  };

  expect(probe).toMatchObject(refusal);
  expect(spawn).toMatchObject(refusal);
  expect(pathSpawn).toMatchObject(refusal);
  expect(existsSync(join(ctx.dir, 'git-ran'))).toBeFalse();
  expect(box.calls).toStrictEqual([]);
});

test('it spawns a local session and a directory outside git under an invalid transport list', async () => {
  await using ctx = await setupTest();

  const loose = join(ctx.dir, 'loose');

  mkdirSync(loose);

  const booted = await ctx.boot(new FixtureDirProvider(), 'invalid');

  const local = await booted.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    target: 'local',
  });

  const inPlace = await booted.client.sendRequest('session.spawn', {
    cwd: loose,
    target: 'local',
    workspace: { kind: 'path', path: loose },
  });

  expect(local).toMatchObject({ session: { cwd: ctx.dir } });
  expect(inPlace).toMatchObject({ session: { cwd: loose } });
});
