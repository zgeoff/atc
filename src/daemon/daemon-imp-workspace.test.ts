import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { updateEnv } from '../../test/update-env';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { DaemonError } from '../protocol/daemon-error';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A real daemon with a `local` target and an imp target `box` over a
 * fixture imp port, whose imps run their commands on this machine, beside
 * a bare upstream and a clone of it with one pushed commit. impd's token
 * `atc-runtime` manages `atc-*` imps and may grant `glm`, which impd holds
 * for api.z.ai. The agent `glm` takes that credential from the broker,
 * and `unsigned` takes it too but fails its sign-in check in the host;
 * `plain` takes none. Fixture git commands read neither the host's system
 * nor its global git config.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-imp-workspace-');
  const sockPath = join(tmp.dir, 'daemon.sock');

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  const upstream = join(tmp.dir, 'upstream.git');
  const work = join(tmp.dir, 'work');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();
  await $`git config user.name atc`.env(env).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(env).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(env).cwd(work).quiet();

  writeFileSync(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const port = new FixtureImpPort();
  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const shared = {
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    normalizeHook: () => ({ kind: 'heartbeat' }) as const,
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  const plain: AgentAdapter = {
    ...shared,
    id: 'plain',
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  };

  const brokered: AgentAdapter = {
    ...shared,
    id: 'glm',
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    planGuestSpawn: (_opts, guest) => ({
      bin: 'sleep',
      args: ['30'],
      files: {},
      env: { ...guest.auth?.env, CLAUDE_CONFIG_DIR: `${guest.dir}/claude-config` },
    }),
    findAuthSelection: () => ({
      gateway: {
        id: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
      profiles: new Map([
        [
          'glm',
          {
            name: 'glm',
            secret: 'glm',
            kind: 'custom',
            host: 'api.z.ai',
            header: 'authorization',
            scheme: 'bearer',
            dependencies: [],
          },
        ],
      ]),
    }),
  };

  const unsigned: AgentAdapter = {
    ...brokered,
    id: 'unsigned',
    planAuthCheck: () => ['false'],
  };

  const daemon = await startDaemon({
    gitTransports: ['https', 'ssh', 'http', 'file'],
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: plain,
    adapters: [plain, brokered, unsigned],
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    targets: [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: 'local-pty:test',
        provider: new LocalPTYProvider(),
      },
      { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider },
    ],
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    port,
    dir: tmp.dir,
    upstream,
    work,
    dbPath: join(tmp.dir, 'state.db'),
    async [Symbol.asyncDispose]() {
      port.stopCommandHold();
      client.stop();

      await daemon.stop();

      provider.dispose();
      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it materializes a workspace on the host of an imp spawn and starts the session there', async () => {
  await using daemon = await setupTest();

  const dest = join(daemon.dir, 'box', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
  });

  const session = getRecord(spawned, 'session');
  const imp = `atc-${String(session['id']).replaceAll('-', '').slice(0, 20)}`;

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session,
    claims: daemon.port.calls.filter((call) => call.startsWith(`exec.run ${imp} mkdir`)),
    started: daemon.port.sessionRequests.map((request) => request.kind),
  }).toMatchObject({
    readme: 'hello\n',
    session: { locator: { targetID: 'box' }, alive: true, workspace: { sha: expect.toBeString() } },
    claims: [
      `exec.run ${imp} mkdir -p -- ${join(daemon.dir, 'box')}`,
      `exec.run ${imp} mkdir -- ${dest}`,
    ],
    started: ['start'],
  });
});

test('it materializes a workspace for a local spawn on the daemon host and starts the session there', async () => {
  await using daemon = await setupTest();

  const dest = join(daemon.dir, 'local', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'local',
    workspace: { kind: 'path', path: daemon.work },
  });

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session: getRecord(spawned, 'session'),
    calls: daemon.port.calls,
  }).toMatchObject({
    readme: 'hello\n',
    session: {
      locator: { targetID: 'local' },
      alive: true,
      workspace: { sha: expect.toBeString() },
    },
    calls: [],
  });
});

test('it refuses a workspace sub-session under a revoked parent before resolving its source or touching impd', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  await daemon.client.sendRequest('session.auth.revoke', { session: parentID });

  daemon.port.calls.length = 0;

  // A source that does not exist fails its resolution, so a refusal other
  // than the resolution's shows resolution never ran.
  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'box', 'child'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: join(daemon.dir, 'missing') },
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  const db = new Database(daemon.dbPath, { readonly: true });

  const rows = db.query('select count(*) as n from workspace_materialization').get();

  db.close();

  expect<Record<string, unknown>>({
    calls: daemon.port.calls.filter((call) => !call.startsWith('leases.renew')),
    sessions: getRecord(listed, 'sessions'),
    rows,
  }).toStrictEqual({
    calls: [],
    sessions: [expect.objectContaining({ id: parentID })],
    rows: { n: 0 },
  });
});

test('it materializes a workspace sub-session on the host of a ready parent and starts it there', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const dest = join(daemon.dir, 'box', 'child');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: daemon.work },
  });

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session: getRecord(spawned, 'session'),
    imps: daemon.port.collectImpNames(),
  }).toMatchObject({
    readme: 'hello\n',
    session: { alive: true, workspace: { sha: expect.toBeString() } },
    imps: [expect.toBeString()],
  });
});

test('it destroys the host of its own that a spawn readied when its workspace fails there', async () => {
  await using daemon = await setupTest();

  const dest = join(daemon.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists' });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect<Record<string, unknown>>({
    created: daemon.port.calls.filter((call) => call.startsWith('imps.create')),
    imps: daemon.port.collectImpNames(),
    listed,
  }).toStrictEqual({
    created: [expect.toBeString()],
    imps: [],
    listed: { sessions: [] },
  });
});

test('it takes back the imp and binding a brokered spawn provisioned when its workspace fails there', async () => {
  await using daemon = await setupTest();

  const dest = join(daemon.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists' });

  await spawn.catch(() => null);

  const db = new Database(daemon.dbPath, { readonly: true });

  const rows = db.query('select count(*) as n from runtime_auth_binding').get();

  db.close();

  expect<Record<string, unknown>>({
    created: daemon.port.calls.filter((call) => call.startsWith('imps.create')),
    imps: daemon.port.collectImpNames(),
    rows,
  }).toStrictEqual({
    created: [expect.toBeString()],
    imps: [],
    rows: { n: 0 },
  });
});

test("it leaves a parent running on its host when a sub-session's workspace fails there", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const dest = join(daemon.dir, 'box', 'child');

  mkdirSync(dest, { recursive: true });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists' });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  const [imp] = daemon.port.collectImpNames();

  expect<Record<string, unknown>>({
    state: daemon.port.findState(String(imp)),
    listed,
  }).toStrictEqual({
    state: 'running',
    listed: { sessions: [expect.objectContaining({ id: parentID, alive: true })] },
  });
});

test('it keeps the key of a workspace spawn whose host it cannot take back as outcome_unknown, so a retry creates no imp', async () => {
  await using daemon = await setupTest();

  daemon.port.setDestroyFailure('INTERNAL');

  const params = {
    cwd: join(daemon.dir, 'box', 'ws'),
    agent: 'unsigned',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    idempotencyKey: 'k-1',
  };

  const first = daemon.client.sendRequest('session.spawn', params);

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await first.catch(() => null);

  const retried = daemon.client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await retried.catch(() => null);

  expect(daemon.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toStartWith('imps.create '),
  ]);
});

test('it refuses a workspace spawn whose host fails its sign-in check and takes the host back', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'box', 'ws'),
    agent: 'unsigned',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_not_configured' });

  await spawn.catch(() => null);

  const db = new Database(daemon.dbPath, { readonly: true });

  const rows = db.query('select count(*) as n from runtime_auth_binding').get();

  db.close();

  expect<Record<string, unknown>>({ imps: daemon.port.collectImpNames(), rows }).toStrictEqual({
    imps: [],
    rows: { n: 0 },
  });
});

test("it refuses a sub-session workspace inside its parent's directory before claiming or transferring anything", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  daemon.port.calls.length = 0;

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.work, 'new'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({
    code: 'workspace_overlap',
    data: { session: parentID, dir: join(daemon.work, 'new') },
  });

  await spawn.catch(() => null);

  expect(daemon.port.calls.filter((call) => call.startsWith('exec.run'))).toStrictEqual([]);
});

test("it materializes a sub-session workspace beside its parent's directory on the shared host", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const dest = join(daemon.dir, 'sibling');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: daemon.work },
  });

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session: getRecord(spawned, 'session'),
  }).toMatchObject({
    readme: 'hello\n',
    session: { alive: true, workspace: { sha: expect.toBeString() } },
  });
});

test('it refuses a git workspace whose credential variable is unset before touching impd', async () => {
  await using daemon = await setupTest();

  updateEnv('ATC_TEST_WORKSPACE_TOKEN', undefined);

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: {
      kind: 'git',
      url: `file://${daemon.upstream}`,
      ref: 'main',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_TOKEN' },
    },
  });

  expect(spawn).rejects.toMatchObject({
    code: 'credential_missing',
    data: { phase: 'resolving' },
  });

  await spawn.catch(() => null);

  expect(daemon.port.calls).toStrictEqual([]);
});

test('it materializes a git workspace on an imp host when its credential variable is set', async () => {
  await using daemon = await setupTest();

  updateEnv('ATC_TEST_WORKSPACE_TOKEN', 'workspace-token');

  const dest = join(daemon.dir, 'box', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: {
      kind: 'git',
      url: `file://${daemon.upstream}`,
      ref: 'main',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_TOKEN' },
    },
  });

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session: getRecord(spawned, 'session'),
  }).toMatchObject({
    readme: 'hello\n',
    session: { alive: true, workspace: { sha: expect.toBeString() } },
  });
});

test('it refuses a workspace spawn inside another one still materializing on the shared host before its first mkdir', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(daemon.dir, 'box', 'a');
  const inner = join(outer, 'b');

  daemon.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: daemon.work },
  });

  await waitFor(() => {
    expect(daemon.port.calls).toContainEqual(expect.toEndWith(`mkdir -- ${outer}`));
  });

  const settled: unknown[] = [];

  const innerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: inner,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: daemon.work },
  });

  const innerSettled = (async () => {
    const answer = await innerSpawn.catch((error: unknown) => error);

    settled.push(answer);
  })();

  await waitFor(() => {
    expect([
      ...settled,
      ...daemon.port.calls.filter((call) => call.endsWith(`mkdir -- ${inner}`)),
    ]).not.toBeEmpty();
  });

  daemon.port.stopCommandHold();

  await outerSpawn;
  await innerSettled;

  expect<Record<string, unknown>>({
    settled,
    claims: daemon.port.calls.filter((call) => call.endsWith(`mkdir -- ${inner}`)),
  }).toMatchObject({
    settled: [{ code: 'workspace_overlap', data: { dir: inner } }],
    claims: [],
  });
});

test('it materializes concurrent workspace spawns into sibling directories on the shared host', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const first = join(daemon.dir, 'box', 'a');
  const second = join(daemon.dir, 'box', 'b');

  daemon.port.startCommandHold('tar -x');

  const spawns = [first, second].map((cwd) =>
    daemon.client.sendRequest('session.spawn', {
      cwd,
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace: { kind: 'path', path: daemon.work },
    }),
  );

  await waitFor(() => {
    expect(daemon.port.calls.filter((call) => call.includes('tar -x'))).toHaveLength(2);
  });

  daemon.port.stopCommandHold();

  const spawned = await Promise.all(spawns);

  expect<Record<string, unknown>>({
    sessions: spawned.map((answer) => getRecord(answer, 'session')['alive']),
    readmes: [first, second].map((dir) => readFileSync(join(dir, 'README.md'), 'utf8')),
  }).toStrictEqual({ sessions: [true, true], readmes: ['hello\n', 'hello\n'] });
});

test("it keeps another session's files inside its directory when a workspace spawn rolls back on the shared host", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(daemon.dir, 'box', 'a');

  daemon.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: daemon.work },
  });

  await waitFor(() => {
    expect(daemon.port.calls).toContainEqual(expect.toEndWith(`mkdir -- ${outer}`));
  });

  const nested = daemon.client.sendRequest('session.spawn', {
    cwd: join(outer, 'b'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: daemon.work },
  });

  await nested.catch(() => null);

  mkdirSync(join(outer, 'inner'));
  writeFileSync(join(outer, 'inner', 'keep.txt'), 'kept\n');
  symlinkSync(outer, join(daemon.dir, 'alias'));

  await daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'alias', 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  daemon.port.setCommandFailure('tar -x');
  daemon.port.stopCommandHold();

  expect(outerSpawn).rejects.toMatchObject({ code: 'transfer_failed' });

  await outerSpawn.catch(() => null);

  expect(readFileSync(join(outer, 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it refuses a plain sub-session inside a workspace still materializing on the shared host', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(daemon.dir, 'box', 'a');

  daemon.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: daemon.work },
  });

  await waitFor(() => {
    expect(daemon.port.calls).toContainEqual(expect.toEndWith(`mkdir -- ${outer}`));
  });

  const refusal = await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(outer, 'b'),
      agent: 'glm',
      target: 'box',
      parent: parentID,
    })
    .catch((error: unknown) => error);

  daemon.port.stopCommandHold();

  await outerSpawn;

  expect(refusal).toMatchObject({ code: 'workspace_overlap', data: { dir: join(outer, 'b') } });
});

test('it starts a plain sub-session beside a workspace still materializing on the shared host', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(daemon.dir, 'box', 'a');

  daemon.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: daemon.work },
  });

  await waitFor(() => {
    expect(daemon.port.calls).toContainEqual(expect.toEndWith(`mkdir -- ${outer}`));
  });

  const plain = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  daemon.port.stopCommandHold();

  await outerSpawn;

  expect(getRecord(plain, 'session')['alive']).toBe(true);
});

test('it removes the directory it claimed and gives it back when a workspace spawn rolls back on the shared host', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const outer = join(daemon.dir, 'box', 'a');

  daemon.port.setCommandFailure('tar -x');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'transfer_failed' });

  await spawn.catch(() => null);

  const removed = !existsSync(outer);

  daemon.port.setCommandFailure(null);

  const retried = await daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: daemon.work },
  });

  expect({ removed, alive: getRecord(retried, 'session')['alive'] }).toStrictEqual({
    removed: true,
    alive: true,
  });
});

test("it refuses a workspace destination that a symlink places inside its parent's directory before claiming it", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  symlinkSync(daemon.work, join(daemon.dir, 'alias'));

  const dest = join(daemon.dir, 'alias', 'new');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'workspace_overlap', data: { dir: dest } });

  await spawn.catch(() => null);

  expect(
    daemon.port.calls.filter(
      (call) => call.endsWith(`mkdir -- ${dest}`) || call.includes('tar -x'),
    ),
  ).toStrictEqual([]);
});

test("it refuses a workspace destination inside its parent's relative directory as the host resolves it", async () => {
  await using daemon = await setupTest();

  const home = join(daemon.dir, 'home');

  mkdirSync(join(home, 'proj'), { recursive: true });

  daemon.port.setHomeDir(home);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: 'proj',
    agent: 'glm',
    target: 'box',
  });

  const dest = join(home, 'proj', 'new');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'workspace_overlap', data: { dir: dest } });

  await spawn.catch(() => null);

  expect(
    daemon.port.calls.filter(
      (call) => call.endsWith(`mkdir -- ${dest}`) || call.includes('tar -x'),
    ),
  ).toStrictEqual([]);
});

test('it materializes a workspace through a symlinked directory that leads away from its parent', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  mkdirSync(join(daemon.dir, 'elsewhere'));
  symlinkSync(join(daemon.dir, 'elsewhere'), join(daemon.dir, 'link'));

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'link', 'new'),
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: daemon.work },
  });

  expect<Record<string, unknown>>({
    alive: getRecord(spawned, 'session')['alive'],
    readme: readFileSync(join(daemon.dir, 'elsewhere', 'new', 'README.md'), 'utf8'),
  }).toStrictEqual({ alive: true, readme: 'hello\n' });
});

test('it keeps the key of a workspace spawn whose own host it cannot destroy as outcome_unknown, so a retry creates no imp', async () => {
  await using daemon = await setupTest();

  const dest = join(daemon.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });

  daemon.port.setDestroyFailure('INTERNAL');

  const params = {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    idempotencyKey: 'k-1',
  };

  const first = daemon.client.sendRequest('session.spawn', params);

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await first.catch(() => null);

  const retried = daemon.client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await retried.catch(() => null);

  expect(daemon.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toStartWith('imps.create '),
  ]);
});

test('it keeps the key of a spawn whose failed readying leaves an imp it cannot destroy as outcome_unknown', async () => {
  await using daemon = await setupTest();

  daemon.port.setAcquireFailure(0, 'INTERNAL');
  daemon.port.setDestroyFailure('INTERNAL');

  const params = {
    cwd: join(daemon.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    idempotencyKey: 'k-1',
  };

  const first = daemon.client.sendRequest('session.spawn', params);

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await first.catch(() => null);

  const retried = daemon.client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await retried.catch(() => null);

  expect(daemon.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toStartWith('imps.create '),
  ]);
});

test('it refuses a spawn whose readying fails and destroys the imp the readying created', async () => {
  await using daemon = await setupTest();

  daemon.port.setAcquireFailure(0, 'INTERNAL');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'host_unavailable' });

  await spawn.catch(() => null);

  expect(daemon.port.collectImpNames()).toStrictEqual([]);
});

test('it keeps the files of a session listed inside its directory while a workspace rollback resolves the host', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(daemon.dir, 'box', 'a');

  daemon.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: daemon.work },
  });

  await waitFor(() => {
    expect(daemon.port.calls).toContainEqual(expect.toEndWith(`mkdir -- ${outer}`));
  });

  mkdirSync(join(outer, 'inner'));
  writeFileSync(join(outer, 'inner', 'keep.txt'), 'kept\n');

  daemon.port.setCommandFailure('tar -x');

  const resolvesBefore = daemon.port.calls.filter((call) => call.includes('pwd -P')).length;

  daemon.port.stopCommandHold();
  daemon.port.startCommandHold('pwd -P');

  await waitFor(() => {
    expect(daemon.port.calls.filter((call) => call.includes('pwd -P')).length).toBeGreaterThan(
      resolvesBefore,
    );
  });

  // The rollback's resolution is held while the nested session lists. It
  // reaches the directory through a symlink, since a plain spawn naming a
  // path inside a workspace still materializing is refused.
  symlinkSync(outer, join(daemon.dir, 'alias'));

  await daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'alias', 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  daemon.port.stopCommandHold();

  expect(outerSpawn).rejects.toMatchObject({ code: 'transfer_failed' });

  await outerSpawn.catch(() => null);

  expect(readFileSync(join(outer, 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it refuses a workspace cwd with a dot-dot segment before touching impd', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: `${daemon.dir}/alias/../new`,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });

  await spawn.catch(() => null);

  expect(daemon.port.calls).toStrictEqual([]);
});

test('it refuses a workspace cwd with a control character before touching impd', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'box', 'new\n'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });

  await spawn.catch(() => null);

  expect(daemon.port.calls).toStrictEqual([]);
});

test('it materializes a workspace through a symlink to a directory whose name ends in a newline beside its parent', async () => {
  await using daemon = await setupTest();

  const busy = join(daemon.dir, 'busy');

  mkdirSync(join(busy, 'sub'), { recursive: true });
  mkdirSync(join(busy, 'sub\n'));
  symlinkSync(join(busy, 'sub\n'), join(daemon.dir, 'alias'));

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: join(busy, 'sub'),
    agent: 'glm',
    target: 'box',
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'alias', 'new'),
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: daemon.work },
  });

  expect<Record<string, unknown>>({
    alive: getRecord(spawned, 'session')['alive'],
    readme: readFileSync(join(busy, 'sub\n', 'new', 'README.md'), 'utf8'),
    untouched: existsSync(join(busy, 'sub', 'new')),
  }).toStrictEqual({ alive: true, readme: 'hello\n', untouched: false });
});

test('it removes only the directory it created when a symlink in the requested path changes before a rollback', async () => {
  await using daemon = await setupTest();

  const safe = join(daemon.dir, 'safe');
  const busy = join(daemon.dir, 'busy');
  const alias = join(daemon.dir, 'alias');

  mkdirSync(safe);
  mkdirSync(join(busy, 'new', 'inner'), { recursive: true });
  writeFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'kept\n');
  symlinkSync(safe, alias);

  daemon.port.startCommandHold('tar -x');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(alias, 'new'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
  });

  await waitFor(() => {
    expect(existsSync(join(safe, 'new'))).toBe(true);
  });

  rmSync(alias);
  symlinkSync(busy, alias);

  daemon.port.setCommandFailure('tar -x');
  daemon.port.stopCommandHold();

  const refusal = await spawn.catch((error: unknown) => error);

  if (!(refusal instanceof DaemonError)) {
    throw new TypeError('the spawn was not refused');
  }

  const data = refusal.data ?? {};

  expect<Record<string, unknown>>({
    refusal,
    left: 'leftDir' in data,
    kept: readFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'utf8'),
    removed: !existsSync(join(safe, 'new')),
  }).toMatchObject({
    refusal: { code: 'transfer_failed' },
    left: false,
    kept: 'kept\n',
    removed: true,
  });
});

test('it leaves its directory and reports it when the directory it created no longer resolves to itself before a rollback', async () => {
  await using daemon = await setupTest();

  const safe = join(daemon.dir, 'safe');
  const busy = join(daemon.dir, 'busy');

  mkdirSync(safe);
  mkdirSync(join(busy, 'new', 'inner'), { recursive: true });
  writeFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'kept\n');

  daemon.port.startCommandHold('tar -x');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(safe, 'new'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
  });

  await waitFor(() => {
    expect(existsSync(join(safe, 'new'))).toBe(true);
  });

  renameSync(safe, join(daemon.dir, 'safe-old'));
  symlinkSync(busy, safe);

  daemon.port.setCommandFailure('tar -x');
  daemon.port.stopCommandHold();

  const refusal = await spawn.catch((error: unknown) => error);

  expect<Record<string, unknown>>({
    refusal,
    kept: readFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'utf8'),
    left: existsSync(join(daemon.dir, 'safe-old', 'new')),
  }).toMatchObject({
    refusal: { code: 'transfer_failed', data: { leftDir: join(safe, 'new') } },
    kept: 'kept\n',
    left: true,
  });
});
