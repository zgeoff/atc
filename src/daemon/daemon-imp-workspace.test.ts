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
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubBrokeredGatewayAdapter } from '../test-utils/build-stub-brokered-gateway-adapter';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * The runtime an imp workspace spawn runs on: a stub imp port whose imps
 * run their commands on this machine, an imp provider over it, and a temp
 * directory `dir` for the test's host paths, beside a git fixture: a bare
 * upstream and a clone of it whose one pushed commit adds `README.md`, at
 * commit `sha`. Each test sets impd's token and secret and starts its own
 * daemon with the agents and targets it selects.
 */
async function setupTest() {
  const git = await createGitFixture({ prefix: 'atc-imp-workspace-git-' });

  const tmp = setupTempDir('atc-imp-workspace-');
  const port = createStubImpPort();

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  registerTestCleanup(() => {
    provider.dispose();
  });

  return {
    port,
    provider,
    dir: tmp.dir,
    upstream: git.upstream,
    work: git.work,
    sha: git.sha,
    env: git.env,
  };
}

test('it materializes a workspace on the host of an imp spawn and starts the session there', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const dest = join(ctx.dir, 'box', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  const session = getRecord(spawned, 'session');
  const [imp] = ctx.port.collectImpNames();

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(committed);

  expect(session).toMatchObject({
    locator: { targetID: 'box' },
    alive: true,
    workspace: { sha: ctx.sha },
  });

  expect<readonly unknown[]>(ctx.port.collectImpNames()).toStrictEqual([
    expect.stringMatching(/^atc-[0-9a-f]{20}$/),
  ]);

  expect(ctx.port.calls.filter((call) => call.startsWith(`exec.run ${imp} mkdir`))).toStrictEqual([
    `exec.run ${imp} mkdir -p -- ${join(ctx.dir, 'box')}`,
    `exec.run ${imp} mkdir -- ${dest}`,
  ]);

  expect(
    ctx.port.calls.filter((call) => call.includes(dest) && call.includes('tar -x')),
  ).toStrictEqual([
    `exec.run ${imp} sh -c mkdir -p "$1" && tar -x --no-same-owner -f - -C "$1" sh ${dest}`,
  ]);

  expect(ctx.port.sessionRequests.map((request) => request.kind)).toStrictEqual(['start']);
});

test('it materializes a git source without a cwd under the home of an imp and starts the session in it', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const home = join(ctx.dir, 'guest-home');
  const dest = join(home, '.local/share/atc/workspaces', 'upstream-main');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main' },
  });

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(committed);

  expect(getRecord(spawned, 'session')).toMatchObject({
    cwd: dest,
    repoRoot: dest,
    locator: { targetID: 'box' },
    alive: true,
  });

  expect(
    ctx.port.sessionRequests.flatMap((request) => (request.kind === 'start' ? [request.cwd] : [])),
  ).toStrictEqual([dest]);
});

test('it lands concurrent sub-sessions of one repository without a cwd side by side on their shared imp', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const home = join(ctx.dir, 'guest-home');
  const base = join(home, '.local/share/atc/workspaces', 'upstream-main');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const workspace = { kind: 'git', url: ctx.upstream, ref: 'main' };

  const spawned = await Promise.all([
    daemon.client.sendRequest('session.spawn', {
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace,
    }),
    daemon.client.sendRequest('session.spawn', {
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace,
    }),
  ]);

  const dirs = spawned.map((answer) => getRecord(answer, 'session')['cwd']);

  expect(dirs).toIncludeSameMembers([base, `${base}-2`]);
  expect(readFileSync(join(base, 'README.md'), 'utf8')).toBe(committed);
  expect(readFileSync(join(`${base}-2`, 'README.md'), 'utf8')).toBe(committed);
});

test('it materializes a workspace for a local spawn on the daemon host and starts the session there', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const dest = join(ctx.dir, 'local', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'local',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(committed);

  expect(getRecord(spawned, 'session')).toMatchObject({
    locator: { targetID: 'local' },
    alive: true,
    workspace: { sha: ctx.sha },
  });

  expect(ctx.port.calls).toStrictEqual([]);
});

test('it refuses a workspace sub-session under a revoked parent before resolving its source or touching impd', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  await daemon.client.sendRequest('session.auth.revoke', { session: parentID });

  ctx.port.calls.length = 0;

  // A source that does not exist fails its resolution, so a refusal other
  // than the resolution's shows resolution never ran.
  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'child'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: join(ctx.dir, 'missing') },
  });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  const db = new Database(daemon.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query('select count(*) as n from workspace_materialization').get();

  expect(spawn).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });
  expect(ctx.port.calls.filter((call) => !call.startsWith('leases.renew'))).toStrictEqual([]);
  expect(listed['sessions']).toStrictEqual([expect.objectContaining({ id: parentID })]);
  expect(rows).toStrictEqual({ n: 0 });
});

test('it materializes a workspace sub-session on the host of a ready parent and starts it there', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const dest = join(ctx.dir, 'box', 'child');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(committed);

  expect(getRecord(spawned, 'session')).toMatchObject({
    alive: true,
    workspace: { sha: ctx.sha },
  });

  expect<readonly unknown[]>(ctx.port.collectImpNames()).toStrictEqual([expect.toBeString()]);
});

test('it destroys the host of its own that a spawn readied when its workspace fails there', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists' });

  expect(ctx.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toBeString(),
  ]);

  expect(ctx.port.collectImpNames()).toStrictEqual([]);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it takes back the imp and binding a brokered spawn provisioned when its workspace fails there', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  const db = new Database(daemon.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query('select count(*) as n from runtime_auth_binding').get();

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists' });

  expect(ctx.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toBeString(),
  ]);

  expect(ctx.port.collectImpNames()).toStrictEqual([]);
  expect(rows).toStrictEqual({ n: 0 });
});

test("it leaves a parent running on its host when a sub-session's workspace fails there", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const dest = join(ctx.dir, 'box', 'child');

  mkdirSync(dest, { recursive: true });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  const [imp] = ctx.port.collectImpNames();

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists' });
  expect(ctx.port.findState(String(imp))).toBe('running');

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id: parentID, alive: true })],
  });
});

test('it destroys the host of its own that a plain workspace spawn readied when its agent is not signed in there', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'unsigned-plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({ code: 'auth_not_configured' });

  expect(ctx.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toStartWith('imps.create '),
  ]);

  expect(ctx.port.collectImpNames()).toStrictEqual([]);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it answers outcome_unknown for a workspace spawn whose host it cannot take back after a failed sign-in check', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  ctx.port.setDestroyFailure('INTERNAL');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'unsigned',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'outcome_unknown' });
});

test('it keeps the key of a workspace spawn whose host it cannot take back as outcome_unknown, so a retry creates no imp', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  ctx.port.setDestroyFailure('INTERNAL');

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      agent: 'unsigned',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'k-1',
    })
    .catch(() => null);

  const retried = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'unsigned',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await retried.catch(() => null);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect(ctx.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toStartWith('imps.create '),
  ]);
});

test('it refuses a workspace spawn whose host fails its sign-in check and takes the host back', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'unsigned',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await spawn.catch(() => null);

  const db = new Database(daemon.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query('select count(*) as n from runtime_auth_binding').get();

  expect(spawn).rejects.toMatchObject({ code: 'auth_not_configured' });
  expect(ctx.port.collectImpNames()).toStrictEqual([]);
  expect(rows).toStrictEqual({ n: 0 });
});

test("it refuses a sub-session workspace inside its parent's directory before claiming or transferring anything", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  ctx.port.calls.length = 0;

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.work, 'new'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'workspace_overlap',
    data: { session: parentID, dir: join(ctx.work, 'new') },
  });

  expect(ctx.port.calls.filter((call) => call.startsWith('exec.run'))).toStrictEqual([]);
});

test("it materializes a sub-session workspace beside its parent's directory on the shared host", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const dest = join(ctx.dir, 'sibling');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(committed);

  expect(getRecord(spawned, 'session')).toMatchObject({
    alive: true,
    workspace: { sha: ctx.sha },
  });
});

test('it refuses a git workspace whose credential variable is unset before touching impd', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  updateEnv('ATC_TEST_WORKSPACE_TOKEN', undefined);

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: {
      kind: 'git',
      url: `file://${ctx.upstream}`,
      ref: 'main',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_TOKEN' },
    },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'credential_missing',
    data: { phase: 'resolving' },
  });

  expect(ctx.port.calls).toStrictEqual([]);
});

test('it materializes a git workspace on an imp host when its credential variable is set', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  updateEnv('ATC_TEST_WORKSPACE_TOKEN', 'workspace-token');

  const dest = join(ctx.dir, 'box', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: {
      kind: 'git',
      url: `file://${ctx.upstream}`,
      ref: 'main',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_TOKEN' },
    },
  });

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(committed);

  expect(getRecord(spawned, 'session')).toMatchObject({
    alive: true,
    workspace: { sha: ctx.sha },
  });
});

test('it claims the directory of a workspace sub-session on the shared host before it unpacks there', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  // The daemon stops with this spawn still held, which rejects it.
  void Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      cwd: outer,
      agent: 'glm',
      target: 'box',
      parent: getRecord(parent, 'session')['id'],
      workspace: { kind: 'path', path: ctx.work },
    }),
  ]);

  const held = await tarHold.entered;

  expect(held).toEndWith(` sh ${outer}`);
  expect(ctx.port.calls).toContainEqual(expect.toEndWith(`mkdir -- ${outer}`));
  expect(existsSync(outer)).toBeTrue();
});

test('it claims the directory of a workspace sub-session under the home of the shared host before it unpacks there', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const home = join(ctx.dir, 'box');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const outer = join(home, 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  // The daemon stops with this spawn still held, which rejects it.
  void Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      cwd: outer,
      agent: 'glm',
      target: 'box',
      parent: getRecord(parent, 'session')['id'],
      workspace: { kind: 'path', path: ctx.work },
    }),
  ]);

  const held = await tarHold.entered;

  expect(held).toEndWith(` sh ${outer}`);
  expect(ctx.port.calls).toContainEqual(expect.toEndWith(`mkdir -- ${outer}`));
  expect(existsSync(outer)).toBeTrue();
});

test('it refuses a workspace spawn inside another one still materializing on the shared host before its first mkdir', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const inner = join(outer, 'b');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  const innerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: inner,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  const innerSettled = Promise.allSettled([innerSpawn]);

  // The inner spawn either settles or claims its directory while the outer
  // one is held.
  await waitFor(() => {
    expect([
      Bun.peek.status(innerSpawn),
      ...ctx.port.calls.filter((call) => call.endsWith(`mkdir -- ${inner}`)),
    ]).not.toStrictEqual(['pending']);
  });

  tarHold.stop();

  await Promise.allSettled([outerSpawn, innerSettled]);

  expect(innerSpawn).rejects.toMatchObject({ code: 'workspace_overlap', data: { dir: inner } });
  expect(outerSpawn).resolves.toContainKey('session');
  expect(ctx.port.calls.filter((call) => call.endsWith(`mkdir -- ${inner}`))).toStrictEqual([]);
});

test('it materializes concurrent workspace spawns into sibling directories on the shared host', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const first = join(ctx.dir, 'box', 'a');
  const second = join(ctx.dir, 'box', 'b');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const spawns = [first, second].map((cwd) =>
    daemon.client.sendRequest('session.spawn', {
      cwd,
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace: { kind: 'path', path: ctx.work },
    }),
  );

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.includes('tar -x'))).toHaveLength(2);
  });

  tarHold.stop();

  const spawned = await Promise.all(spawns);

  expect(spawned.map((answer) => getRecord(answer, 'session')['alive'])).toStrictEqual([
    true,
    true,
  ]);

  expect([first, second].map((dir) => readFileSync(join(dir, 'README.md'), 'utf8'))).toStrictEqual([
    committed,
    committed,
  ]);
});

test("it keeps another session's files inside its directory when a workspace spawn rolls back on the shared host", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  const nested = daemon.client.sendRequest('session.spawn', {
    cwd: join(outer, 'b'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await nested.catch(() => null);

  mkdirSync(join(outer, 'inner'));
  writeFileSync(join(outer, 'inner', 'keep.txt'), 'kept\n');
  symlinkSync(outer, join(ctx.dir, 'alias'));

  await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'alias', 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  ctx.port.setCommandFailure('tar -x');
  tarHold.stop();

  await outerSpawn.catch(() => null);

  expect(outerSpawn).rejects.toMatchObject({ code: 'transfer_failed' });
  expect(readFileSync(join(outer, 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it refuses a plain sub-session inside a workspace still materializing on the shared host', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  const refused = daemon.client.sendRequest('session.spawn', {
    cwd: join(outer, 'b'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await refused.catch(() => null);

  tarHold.stop();

  await outerSpawn.catch(() => null);

  expect(refused).rejects.toMatchObject({
    code: 'workspace_overlap',
    data: { dir: join(outer, 'b') },
  });

  expect(outerSpawn).resolves.toContainKey('session');
});

test('it keeps the files of a plain sub-session still starting through a symlink when a workspace rolls back', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  mkdirSync(join(outer, 'inner'));
  writeFileSync(join(outer, 'inner', 'keep.txt'), 'kept\n');
  symlinkSync(outer, join(ctx.dir, 'alias'));

  const leasesBefore = ctx.port.calls.filter((call) => call.startsWith('leases.acquire')).length;

  ctx.port.startLeaseHold();

  // The plain sub-session waits for its lease, before it lists.
  const plain = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'alias', 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(
      ctx.port.calls.filter((call) => call.startsWith('leases.acquire')).length,
    ).toBeGreaterThan(leasesBefore);
  });

  ctx.port.setCommandFailure('tar -x');
  tarHold.stop();

  await outerSpawn.catch(() => null);

  ctx.port.stopLeaseHold();

  await plain.catch(() => null);

  expect(plain).resolves.toContainKey('session');
  expect(readFileSync(join(outer, 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it refuses a plain sub-session on the shared host while a workspace rollback removes its directory', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  // The daemon stops with this spawn still rolling back, which rejects it.
  void Promise.allSettled([outerSpawn]);
  symlinkSync(outer, join(ctx.dir, 'alias'));

  ctx.port.setCommandFailure('tar -x');
  tarHold.stop();

  // The removal stays held until the daemon stops.
  ctx.port.startCommandHold('find . -mindepth');

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.includes('find . -mindepth'))).not.toBeEmpty();
  });

  const refused = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'alias', 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await refused.catch(() => null);

  expect(refused).rejects.toMatchObject({ code: 'workspace_overlap' });
});

test('it starts a plain sub-session on the shared host once a workspace rollback that refused one has removed its directory', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  symlinkSync(outer, join(ctx.dir, 'alias'));

  ctx.port.setCommandFailure('tar -x');
  tarHold.stop();

  const removalHold = ctx.port.startCommandHold('find . -mindepth');

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.includes('find . -mindepth'))).not.toBeEmpty();
  });

  const refused = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'alias', 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await refused.catch(() => null);

  removalHold.stop();
  ctx.port.setCommandFailure(null);

  await outerSpawn.catch(() => null);

  const after = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  expect(refused).rejects.toMatchObject({ code: 'workspace_overlap' });
  expect(getRecord(after, 'session')['alive']).toBe(true);
  expect(existsSync(outer)).toBe(false);
});

test('it keeps the files of a relative plain sub-session still starting when a workspace rolls back', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const home = join(ctx.dir, 'box');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(home, 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  mkdirSync(join(outer, 'inner'));
  writeFileSync(join(outer, 'inner', 'keep.txt'), 'kept\n');

  const leasesBefore = ctx.port.calls.filter((call) => call.startsWith('leases.acquire')).length;

  ctx.port.startLeaseHold();

  // The relative sub-session waits for its lease, before it lists.
  const plain = daemon.client.sendRequest('session.spawn', {
    cwd: 'a/inner',
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(
      ctx.port.calls.filter((call) => call.startsWith('leases.acquire')).length,
    ).toBeGreaterThan(leasesBefore);
  });

  ctx.port.setCommandFailure('tar -x');
  tarHold.stop();

  await outerSpawn.catch(() => null);

  ctx.port.setCommandFailure(null);
  ctx.port.stopLeaseHold();

  await plain.catch(() => null);

  expect(plain).resolves.toContainKey('session');
  expect(readFileSync(join(outer, 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it keeps its directory when a workspace rollback cannot resolve a plain sub-session still starting', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  mkdirSync(join(outer, 'inner'));
  writeFileSync(join(outer, 'inner', 'keep.txt'), 'kept\n');
  symlinkSync(outer, join(ctx.dir, 'alias'));

  const leasesBefore = ctx.port.calls.filter((call) => call.startsWith('leases.acquire')).length;

  ctx.port.startLeaseHold();

  const plain = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'alias', 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(
      ctx.port.calls.filter((call) => call.startsWith('leases.acquire')).length,
    ).toBeGreaterThan(leasesBefore);
  });

  const resolvesBefore = ctx.port.calls.filter((call) => call.includes('pwd -P')).length;

  ctx.port.setCommandFailure('tar -x');
  tarHold.stop();

  const resolveHold = ctx.port.startCommandHold('pwd -P');

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.includes('pwd -P')).length).toBeGreaterThan(
      resolvesBefore,
    );
  });

  // Only the resolution of the plain sub-session's directory fails.
  ctx.port.setCommandFailure(join(ctx.dir, 'alias'));
  resolveHold.stop();

  await outerSpawn.catch(() => null);

  ctx.port.setCommandFailure(null);
  ctx.port.stopLeaseHold();

  await plain.catch(() => null);

  expect(outerSpawn).rejects.toMatchObject({ data: { leftDir: outer } });
  expect(plain).resolves.toContainKey('session');
  expect(readFileSync(join(outer, 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it keeps its directory when a workspace rollback cannot resolve a relative plain sub-session still starting', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const home = join(ctx.dir, 'box');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(home, 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  mkdirSync(join(outer, 'inner'));
  writeFileSync(join(outer, 'inner', 'keep.txt'), 'kept\n');

  const leasesBefore = ctx.port.calls.filter((call) => call.startsWith('leases.acquire')).length;

  ctx.port.startLeaseHold();

  const plain = daemon.client.sendRequest('session.spawn', {
    cwd: 'a/inner',
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(
      ctx.port.calls.filter((call) => call.startsWith('leases.acquire')).length,
    ).toBeGreaterThan(leasesBefore);
  });

  const resolvesBefore = ctx.port.calls.filter((call) => call.includes('pwd -P')).length;

  ctx.port.setCommandFailure('tar -x');
  tarHold.stop();

  const resolveHold = ctx.port.startCommandHold('pwd -P');

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.includes('pwd -P')).length).toBeGreaterThan(
      resolvesBefore,
    );
  });

  // Only the resolution of the relative directory, which runs in it, fails.
  ctx.port.setCommandFailure(' sh .');
  resolveHold.stop();

  await outerSpawn.catch(() => null);

  ctx.port.setCommandFailure(null);
  ctx.port.stopLeaseHold();

  await plain.catch(() => null);

  expect(outerSpawn).rejects.toMatchObject({ data: { leftDir: outer } });
  expect(plain).resolves.toContainKey('session');
  expect(readFileSync(join(outer, 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it starts a plain sub-session beside a workspace still materializing on the shared host', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  const plain = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  tarHold.stop();

  await outerSpawn.catch(() => null);

  expect(getRecord(plain, 'session')['alive']).toBeTrue();
  expect(outerSpawn).resolves.toContainKey('session');
});

test('it removes the directory it claimed when a workspace spawn rolls back on the shared host', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const outer = join(ctx.dir, 'box', 'a');

  ctx.port.setCommandFailure('tar -x');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'transfer_failed' });
  expect(existsSync(outer)).toBeFalse();
});

test('it gives back the directory a rolled-back workspace spawn claimed, so a retry materializes there', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  ctx.port.setCommandFailure('tar -x');

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'a'),
      agent: 'glm',
      target: 'box',
      parent: getRecord(parent, 'session')['id'],
      workspace: { kind: 'path', path: ctx.work },
    })
    .catch(() => null);

  ctx.port.setCommandFailure(null);

  const parentID = getRecord(parent, 'session')['id'];

  const retried = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'a'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(getRecord(retried, 'session')['alive']).toBeTrue();
});

test("it removes a sub-session's checkout but keeps its parent and the files beside it when its start fails on the shared host", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const dest = join(ctx.dir, 'box', 'child');

  // The imp the parent's spawn created, which the failed start must keep.
  const [imp] = ctx.port.collectImpNames();

  mkdirSync(join(ctx.dir, 'box'));
  writeFileSync(join(ctx.dir, 'box', 'beside.txt'), 'kept\n');

  ctx.port.startBrokerFailure();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({ code: 'broker_not_ready' });
  expect(existsSync(dest)).toBe(false);
  expect(readFileSync(join(ctx.dir, 'box', 'beside.txt'), 'utf8')).toBe('kept\n');
  expect(readFileSync(join(ctx.work, 'README.md'), 'utf8')).toBe(committed);
  expect<readonly unknown[]>(ctx.port.collectImpNames()).toStrictEqual([imp]);
  expect(ctx.port.findState(String(imp))).toBe('running');

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id: parentID, alive: true })],
  });
});

test('it spawns a sub-session again on the shared host after its failed start removed its checkout', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  // The imp the parent's spawn created, which the failed start must keep.
  const [imp] = ctx.port.collectImpNames();

  mkdirSync(join(ctx.dir, 'box'));
  writeFileSync(join(ctx.dir, 'box', 'beside.txt'), 'kept\n');

  ctx.port.startBrokerFailure();

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'child'),
      agent: 'glm',
      target: 'box',
      parent: getRecord(parent, 'session')['id'],
      workspace: { kind: 'path', path: ctx.work },
    })
    .catch(() => null);

  ctx.port.stopBrokerFailure();

  const parentID = getRecord(parent, 'session')['id'];

  const retried = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'child'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  const retriedID = getRecord(retried, 'session')['id'];

  const after = await daemon.client.sendRequest('session.list');

  expect(readFileSync(join(ctx.dir, 'box', 'beside.txt'), 'utf8')).toBe('kept\n');
  expect(readFileSync(join(ctx.work, 'README.md'), 'utf8')).toBe(committed);
  expect<readonly unknown[]>(ctx.port.collectImpNames()).toStrictEqual([imp]);
  expect(ctx.port.findState(String(imp))).toBe('running');
  expect(getRecord(retried, 'session')['alive']).toBe(true);

  expect(after).toStrictEqual({
    sessions: expect.toIncludeSameMembers([
      expect.objectContaining({ id: parentID, alive: true }),
      expect.objectContaining({ id: retriedID, alive: true }),
    ]),
  });
});

test("it removes a sub-session's checkout on its parent's sleeping host when its start fails there, then lets the host sleep again", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const [imp] = ctx.port.collectImpNames();
  const dest = join(ctx.dir, 'box', 'child');

  ctx.port.suspendWithForce(String(imp));

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed).toMatchObject({
      sessions: [{ id: parentID, lifecycle: { vm: 'asleep' } }],
    });
  });

  const stateBeforeSpawn = ctx.port.findState(String(imp));
  const callsBeforeSpawn = ctx.port.calls.length;

  ctx.port.startBrokerFailure();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'broker_not_ready' });
  expect(existsSync(dest)).toBe(false);
  expect(stateBeforeSpawn).toBe('sleeping');

  expect(
    ctx.port.calls
      .slice(callsBeforeSpawn)
      .filter((call) => call.startsWith(`leases.acquire ${imp} `) || call === `imps.sleep ${imp}`),
  ).toStrictEqual([expect.toStartWith(`leases.acquire ${imp} `), `imps.sleep ${imp}`]);

  expect(ctx.port.findState(String(imp))).toBe('sleeping');
});

test("it answers outcome_unknown and logs the path of a sub-session's checkout it cannot remove when its start fails on the shared host", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const dest = join(ctx.dir, 'box', 'child');

  ctx.port.startBrokerFailure();
  ctx.port.setCommandFailure('-mindepth');

  const params = {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  };

  const first = daemon.client.sendRequest('session.spawn', params);

  await first.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(existsSync(join(dest, 'README.md'))).toBe(true);

  expect(daemon.logs.filter((line) => line.startsWith(`atc: left ${dest} `))).toStrictEqual([
    expect.toEndWith('; remove it by hand'),
  ]);

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id: parentID, alive: true })],
  });
});

test("it keeps the key of a sub-session's checkout it cannot remove, so a retry is answered outcome_unknown", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  ctx.port.startBrokerFailure();
  ctx.port.setCommandFailure('-mindepth');

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'child'),
      agent: 'glm',
      target: 'box',
      parent: getRecord(parent, 'session')['id'],
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'k-1',
    })
    .catch(() => null);

  const parentID = getRecord(parent, 'session')['id'];
  const dest = join(ctx.dir, 'box', 'child');

  const retried = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await retried.catch(() => null);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect(daemon.logs.filter((line) => line.startsWith(`atc: left ${dest} `))).toStrictEqual([
    expect.toEndWith('; remove it by hand'),
  ]);
});

test("it keeps the claim on a sub-session's checkout it cannot remove, so a spawn inside it is refused", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  ctx.port.startBrokerFailure();
  ctx.port.setCommandFailure('-mindepth');

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'child'),
      agent: 'glm',
      target: 'box',
      parent: getRecord(parent, 'session')['id'],
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'k-1',
    })
    .catch(() => null);

  const parentID = getRecord(parent, 'session')['id'];
  const dest = join(ctx.dir, 'box', 'child');

  const inside = daemon.client.sendRequest('session.spawn', {
    cwd: join(dest, 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await inside.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(inside).rejects.toMatchObject({ code: 'workspace_overlap' });
  expect(existsSync(join(dest, 'README.md'))).toBe(true);

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id: parentID, alive: true })],
  });
});

test("it refuses a workspace destination that a symlink places inside its parent's directory before claiming it", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  symlinkSync(ctx.work, join(ctx.dir, 'alias'));

  const dest = join(ctx.dir, 'alias', 'new');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'workspace_overlap', data: { dir: dest } });

  expect(
    ctx.port.calls.filter((call) => call.endsWith(`mkdir -- ${dest}`) || call.includes('tar -x')),
  ).toStrictEqual([]);
});

test("it refuses a workspace destination inside its parent's relative directory as the host resolves it", async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const home = join(ctx.dir, 'home');

  mkdirSync(join(home, 'proj'), { recursive: true });

  ctx.port.setHomeDir(home);

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
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'workspace_overlap', data: { dir: dest } });

  expect(
    ctx.port.calls.filter((call) => call.endsWith(`mkdir -- ${dest}`) || call.includes('tar -x')),
  ).toStrictEqual([]);
});

test('it materializes a workspace through a symlinked directory that leads away from its parent', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  mkdirSync(join(ctx.dir, 'elsewhere'));
  symlinkSync(join(ctx.dir, 'elsewhere'), join(ctx.dir, 'link'));

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'link', 'new'),
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(getRecord(spawned, 'session')['alive']).toBe(true);
  expect(readFileSync(join(ctx.dir, 'elsewhere', 'new', 'README.md'), 'utf8')).toBe(committed);
});

test('it answers outcome_unknown for a workspace spawn whose own host it cannot destroy after its workspace fails', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });

  ctx.port.setDestroyFailure('INTERNAL');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'outcome_unknown' });
});

test('it keeps the key of a workspace spawn whose own host it cannot destroy as outcome_unknown, so a retry creates no imp', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  mkdirSync(join(ctx.dir, 'box', 'ws'), { recursive: true });

  ctx.port.setDestroyFailure('INTERNAL');

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      agent: 'plain',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'k-1',
    })
    .catch(() => null);

  const retried = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await retried.catch(() => null);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect(ctx.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toStartWith('imps.create '),
  ]);
});

test('it answers outcome_unknown for a spawn whose failed readying leaves an imp it cannot destroy', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  ctx.port.setAcquireFailure(0, 'INTERNAL');
  ctx.port.setDestroyFailure('INTERNAL');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'outcome_unknown' });
});

test('it keeps the key of a spawn whose failed readying leaves an imp it cannot destroy as outcome_unknown, so a retry creates no imp', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  ctx.port.setAcquireFailure(0, 'INTERNAL');
  ctx.port.setDestroyFailure('INTERNAL');

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      agent: 'plain',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'k-1',
    })
    .catch(() => null);

  const retried = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await retried.catch(() => null);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect(ctx.port.calls.filter((call) => call.startsWith('imps.create'))).toStrictEqual([
    expect.toStartWith('imps.create '),
  ]);
});

test('it refuses a spawn whose readying fails and destroys the imp the readying created', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  ctx.port.setAcquireFailure(0, 'INTERNAL');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'host_unavailable' });

  expect(ctx.port.calls.filter((call) => call.startsWith('imps.create '))).toStrictEqual([
    expect.toStartWith('imps.create atc-'),
  ]);

  expect(ctx.port.collectImpNames()).toStrictEqual([]);
});

test('it keeps the files of a session listed inside its directory while a workspace rollback resolves the host', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = daemon.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  mkdirSync(join(outer, 'inner'));
  writeFileSync(join(outer, 'inner', 'keep.txt'), 'kept\n');

  ctx.port.setCommandFailure('tar -x');

  const resolvesBefore = ctx.port.calls.filter((call) => call.includes('pwd -P')).length;

  tarHold.stop();

  const resolveHold = ctx.port.startCommandHold('pwd -P');

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.includes('pwd -P')).length).toBeGreaterThan(
      resolvesBefore,
    );
  });

  // The rollback's resolution is held while the nested session lists. It
  // reaches the directory through a symlink, since a plain spawn naming a
  // path inside a workspace still materializing is refused.
  symlinkSync(outer, join(ctx.dir, 'alias'));

  await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'alias', 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  resolveHold.stop();

  await outerSpawn.catch(() => null);

  expect(outerSpawn).rejects.toMatchObject({ code: 'transfer_failed' });
  expect(readFileSync(join(outer, 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
});

test('it refuses a workspace cwd with a dot-dot segment before touching impd', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: `${ctx.dir}/alias/../new`,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it refuses a workspace cwd with a control character before touching impd', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'new\n'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it materializes a workspace through a symlink to a directory whose name ends in a newline beside its parent', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const busy = join(ctx.dir, 'busy');

  mkdirSync(join(busy, 'sub'), { recursive: true });
  mkdirSync(join(busy, 'sub\n'));
  symlinkSync(join(busy, 'sub\n'), join(ctx.dir, 'alias'));

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: join(busy, 'sub'),
    agent: 'glm',
    target: 'box',
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'alias', 'new'),
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(getRecord(spawned, 'session')['alive']).toBe(true);
  expect(readFileSync(join(busy, 'sub\n', 'new', 'README.md'), 'utf8')).toBe(committed);
  expect(existsSync(join(busy, 'sub', 'new'))).toBe(false);
});

test('it removes only the directory it created when a symlink in the requested path changes before a rollback', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const safe = join(ctx.dir, 'safe');
  const busy = join(ctx.dir, 'busy');
  const alias = join(ctx.dir, 'alias');

  mkdirSync(safe);
  mkdirSync(join(busy, 'new', 'inner'), { recursive: true });
  writeFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'kept\n');
  symlinkSync(safe, alias);

  const tarHold = ctx.port.startCommandHold('tar -x');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(alias, 'new'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await waitFor(() => {
    expect(existsSync(join(safe, 'new'))).toBeTrue();
  });

  rmSync(alias);
  symlinkSync(busy, alias);

  ctx.port.setCommandFailure('tar -x');
  tarHold.stop();

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'transfer_failed' });
  expect(spawn).rejects.not.toMatchObject({ data: { leftDir: expect.toBeString() } });
  expect(readFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
  expect(existsSync(join(safe, 'new'))).toBe(false);
});

test('it leaves its directory and reports it when the directory it created no longer resolves to itself before a rollback', async () => {
  const ctx = await setupTest();

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  // `glm` takes the credential impd holds for api.z.ai from the broker, and
  // `unsigned` takes it too but fails its sign-in check in the host;
  // `plain` takes none, and `unsigned-plain` takes none and fails its
  // sign-in check.
  const plainAdapter = buildMockAgentAdapter({ id: 'plain' });
  const glmAdapter = buildStubBrokeredGatewayAdapter();

  const daemon = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plainAdapter,
      adapters: [
        plainAdapter,
        glmAdapter,
        { ...glmAdapter, id: 'unsigned', planAuthCheck: () => ['false'] },
        buildMockAgentAdapter({ id: 'unsigned-plain', planAuthCheck: () => ['false'] }),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local-pty:test',
          provider: new LocalPTYProvider(),
        },
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
    }),
  });

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  registerTestCleanup(() => {
    ctx.port.stopCommandHold();
    ctx.port.stopLeaseHold();
  });

  const safe = join(ctx.dir, 'safe');
  const busy = join(ctx.dir, 'busy');

  mkdirSync(safe);
  mkdirSync(join(busy, 'new', 'inner'), { recursive: true });
  writeFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'kept\n');

  const tarHold = ctx.port.startCommandHold('tar -x');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(safe, 'new'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await waitFor(() => {
    expect(existsSync(join(safe, 'new'))).toBeTrue();
  });

  renameSync(safe, join(ctx.dir, 'safe-old'));
  symlinkSync(busy, safe);

  ctx.port.setCommandFailure('tar -x');
  tarHold.stop();

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'transfer_failed',
    data: { leftDir: join(safe, 'new') },
  });

  expect(readFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
  expect(existsSync(join(ctx.dir, 'safe-old', 'new'))).toBe(true);
});
