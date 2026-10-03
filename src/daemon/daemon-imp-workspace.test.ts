import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { updateEnv } from '../../test/update-env';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
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
