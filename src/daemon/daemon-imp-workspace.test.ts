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
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A real daemon with a `local` target and an imp target `box` over a
 * stub imp port, whose imps run their commands on this machine, beside
 * a git fixture: a bare upstream and a clone of it whose one pushed commit
 * adds `README.md`, at commit `sha`. `dir` is a temp directory for the
 * test's host paths. The agent `glm` takes the credential impd holds for
 * api.z.ai from the broker, and `unsigned` takes it too but fails its
 * sign-in check in the host; `plain` takes none, and `unsigned-plain`
 * takes none and fails its sign-in check. Every line the daemon logs is
 * kept, and disposal lets every held command and lease go before the
 * daemon stops.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const gitFixture = await createGitFixture({ prefix: 'atc-imp-workspace-git-' });

  const git = stack.use(gitFixture);
  const tmp = stack.use(setupTempDir('atc-imp-workspace-'));
  const port = stack.use(createStubImpPort());

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  stack.defer(() => {
    provider.dispose();
  });

  // The broker sign-in of `glm` and `unsigned` needs impd's token to
  // manage `atc-*` imps and grant `glm`, and impd to hold `glm`.
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

  // The agents every spawn picks from by id.
  const plain = buildMockAgentAdapter({ id: 'plain' });

  const brokered = buildMockAgentAdapter({
    id: 'glm',
    planGuestSpawn: (_opts, guest) => ({
      bin: 'sleep',
      args: ['30'],
      files: {},
      env: { ...guest.auth?.env, CLAUDE_CONFIG_DIR: `${guest.dir}/claude-config` },
    }),
    findAuthSelection: () => ({
      brokerRequired: true,
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
            env: {},
            dependencies: [],
          },
        ],
      ]),
    }),
  });

  const unsigned = { ...brokered, id: 'unsigned', planAuthCheck: () => ['false'] };

  const unsignedPlain = buildMockAgentAdapter({
    id: 'unsigned-plain',
    planAuthCheck: () => ['false'],
  });

  const started = await startTestDaemon({
    prefix: 'atc-imp-workspace-daemon-',
    options: () => ({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      adapter: plain,
      adapters: [plain, brokered, unsigned, unsignedPlain],
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
    }),
  });

  const daemon = stack.use(started);

  // A held command or lease would keep a spawn, and so the daemon's stop,
  // waiting.
  stack.defer(() => {
    port.stopCommandHold();
    port.stopLeaseHold();
  });

  const owned = stack.move();

  return {
    client: daemon.client,
    port,
    dir: tmp.dir,
    upstream: git.upstream,
    work: git.work,
    sha: git.sha,
    env: git.env,
    dbPath: daemon.dbPath,
    logs: daemon.logs,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it materializes a workspace on the host of an imp spawn and starts the session there', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const dest = join(ctx.dir, 'box', 'ws');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  const session = getRecord(spawned, 'session');
  const [imp] = ctx.port.collectImpNames();

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session,
    imps: ctx.port.collectImpNames(),
    claims: ctx.port.calls.filter((call) => call.startsWith(`exec.run ${imp} mkdir`)),
    unpacks: ctx.port.calls.filter((call) => call.includes(dest) && call.includes('tar -x')),
    started: ctx.port.sessionRequests.map((request) => request.kind),
  }).toMatchObject({
    readme: committed,
    session: { locator: { targetID: 'box' }, alive: true, workspace: { sha: expect.toBeString() } },
    imps: [expect.stringMatching(/^atc-[0-9a-f]{20}$/)],
    claims: [
      `exec.run ${imp} mkdir -p -- ${join(ctx.dir, 'box')}`,
      `exec.run ${imp} mkdir -- ${dest}`,
    ],
    unpacks: [
      `exec.run ${imp} sh -c mkdir -p "$1" && tar -x --no-same-owner -f - -C "$1" sh ${dest}`,
    ],
    started: ['start'],
  });
});

test('it materializes a git source without a cwd under the home of an imp and starts the session in it', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const home = join(ctx.dir, 'guest-home');
  const dest = join(home, '.local/share/atc/workspaces', 'upstream-main');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main' },
  });

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session: getRecord(spawned, 'session'),
    started: ctx.port.sessionRequests.flatMap((request) =>
      request.kind === 'start' ? [request.cwd] : [],
    ),
  }).toMatchObject({
    readme: committed,
    session: { cwd: dest, repoRoot: dest, locator: { targetID: 'box' }, alive: true },
    started: [dest],
  });
});

test('it lands concurrent sub-sessions of one repository without a cwd side by side on their shared imp', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const home = join(ctx.dir, 'guest-home');
  const base = join(home, '.local/share/atc/workspaces', 'upstream-main');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const workspace = { kind: 'git', url: ctx.upstream, ref: 'main' };

  const spawned = await Promise.all([
    ctx.client.sendRequest('session.spawn', {
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace,
    }),
    ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const dest = join(ctx.dir, 'local', 'ws');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'local',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session: getRecord(spawned, 'session'),
    calls: ctx.port.calls,
  }).toMatchObject({
    readme: committed,
    session: {
      locator: { targetID: 'local' },
      alive: true,
      workspace: { sha: expect.toBeString() },
    },
    calls: [],
  });
});

test('it refuses a workspace sub-session under a revoked parent before resolving its source or touching impd', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  await ctx.client.sendRequest('session.auth.revoke', { session: parentID });

  ctx.port.calls.length = 0;

  // A source that does not exist fails its resolution, so a refusal other
  // than the resolution's shows resolution never ran.
  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'child'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: join(ctx.dir, 'missing') },
  });

  await spawn.catch(() => null);

  const listed = await ctx.client.sendRequest('session.list');

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('select count(*) as n from workspace_materialization').get();

  expect(spawn).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls.filter((call) => !call.startsWith('leases.renew')),
    sessions: getRecord(listed, 'sessions'),
    rows,
  }).toStrictEqual({
    calls: [],
    sessions: [expect.objectContaining({ id: parentID })],
    rows: { n: 0 },
  });
});

test('it materializes a workspace sub-session on the host of a ready parent and starts it there', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const dest = join(ctx.dir, 'box', 'child');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session: getRecord(spawned, 'session'),
    imps: ctx.port.collectImpNames(),
  }).toMatchObject({
    readme: committed,
    session: { alive: true, workspace: { sha: expect.toBeString() } },
    imps: [expect.toBeString()],
  });
});

test('it destroys the host of its own that a spawn readied when its workspace fails there', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await spawn.catch(() => null);

  const listed = await ctx.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists' });

  expect<Record<string, unknown>>({
    created: ctx.port.calls.filter((call) => call.startsWith('imps.create')),
    imps: ctx.port.collectImpNames(),
    listed,
  }).toStrictEqual({
    created: [expect.toBeString()],
    imps: [],
    listed: { sessions: [] },
  });
});

test('it takes back the imp and binding a brokered spawn provisioned when its workspace fails there', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('select count(*) as n from runtime_auth_binding').get();

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists' });

  expect<Record<string, unknown>>({
    created: ctx.port.calls.filter((call) => call.startsWith('imps.create')),
    imps: ctx.port.collectImpNames(),
    rows,
  }).toStrictEqual({
    created: [expect.toBeString()],
    imps: [],
    rows: { n: 0 },
  });
});

test("it leaves a parent running on its host when a sub-session's workspace fails there", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const dest = join(ctx.dir, 'box', 'child');

  mkdirSync(dest, { recursive: true });

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  const listed = await ctx.client.sendRequest('session.list');

  const [imp] = ctx.port.collectImpNames();

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists' });

  expect<Record<string, unknown>>({
    state: ctx.port.findState(String(imp)),
    listed,
  }).toStrictEqual({
    state: 'running',
    listed: { sessions: [expect.objectContaining({ id: parentID, alive: true })] },
  });
});

test('it destroys the host of its own that a plain workspace spawn readied when its agent is not signed in there', async () => {
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'unsigned-plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'auth_not_configured' });

  expect<Record<string, unknown>>({
    created: ctx.port.calls.filter((call) => call.startsWith('imps.create')),
    imps: ctx.port.collectImpNames(),
    listed: await ctx.client.sendRequest('session.list'),
  }).toStrictEqual({
    created: [expect.toStartWith('imps.create ')],
    imps: [],
    listed: { sessions: [] },
  });
});

test('it answers outcome_unknown for a workspace spawn whose host it cannot take back after a failed sign-in check', async () => {
  await using ctx = await setupTest();

  ctx.port.setDestroyFailure('INTERNAL');

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'unsigned',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'outcome_unknown' });
});

test('it keeps the key of a workspace spawn whose host it cannot take back as outcome_unknown, so a retry creates no imp', async () => {
  await using ctx = await setupTest();

  ctx.port.setDestroyFailure('INTERNAL');

  await ctx.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      agent: 'unsigned',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'k-1',
    })
    .catch(() => null);

  const retried = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'unsigned',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await spawn.catch(() => null);

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('select count(*) as n from runtime_auth_binding').get();

  expect(spawn).rejects.toMatchObject({ code: 'auth_not_configured' });

  expect<Record<string, unknown>>({ imps: ctx.port.collectImpNames(), rows }).toStrictEqual({
    imps: [],
    rows: { n: 0 },
  });
});

test("it refuses a sub-session workspace inside its parent's directory before claiming or transferring anything", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  ctx.port.calls.length = 0;

  const spawn = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const dest = join(ctx.dir, 'sibling');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session: getRecord(spawned, 'session'),
  }).toMatchObject({
    readme: committed,
    session: { alive: true, workspace: { sha: expect.toBeString() } },
  });
});

test('it refuses a git workspace whose credential variable is unset before touching impd', async () => {
  await using ctx = await setupTest();

  updateEnv('ATC_TEST_WORKSPACE_TOKEN', undefined);

  const spawn = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  updateEnv('ATC_TEST_WORKSPACE_TOKEN', 'workspace-token');

  const dest = join(ctx.dir, 'box', 'ws');

  const spawned = await ctx.client.sendRequest('session.spawn', {
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

  expect<Record<string, unknown>>({
    readme: readFileSync(join(dest, 'README.md'), 'utf8'),
    session: getRecord(spawned, 'session'),
  }).toMatchObject({
    readme: committed,
    session: { alive: true, workspace: { sha: expect.toBeString() } },
  });
});

test('it claims the directory of a workspace sub-session on the shared host before it unpacks there', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  // The daemon stops with this spawn still held, which rejects it.
  void Promise.allSettled([
    ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const home = join(ctx.dir, 'box');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const outer = join(home, 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  // The daemon stops with this spawn still held, which rejects it.
  void Promise.allSettled([
    ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const inner = join(outer, 'b');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  const innerSpawn = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const first = join(ctx.dir, 'box', 'a');
  const second = join(ctx.dir, 'box', 'b');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const spawns = [first, second].map((cwd) =>
    ctx.client.sendRequest('session.spawn', {
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

  expect<Record<string, unknown>>({
    sessions: spawned.map((answer) => getRecord(answer, 'session')['alive']),
    readmes: [first, second].map((dir) => readFileSync(join(dir, 'README.md'), 'utf8')),
  }).toStrictEqual({ sessions: [true, true], readmes: [committed, committed] });
});

test("it keeps another session's files inside its directory when a workspace spawn rolls back on the shared host", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  const nested = ctx.client.sendRequest('session.spawn', {
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

  await ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  const refused = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
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
  const plain = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
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

  const refused = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'alias', 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await refused.catch(() => null);

  expect(refused).rejects.toMatchObject({ code: 'workspace_overlap' });
});

test('it starts a plain sub-session on the shared host once a workspace rollback that refused one has removed its directory', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
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

  await ctx.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'alias', 'inner'),
      agent: 'glm',
      target: 'box',
      parent: parentID,
    })
    .catch(() => null);

  removalHold.stop();
  ctx.port.setCommandFailure(null);

  await outerSpawn.catch(() => null);

  const after = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  expect<Record<string, unknown>>({
    alive: getRecord(after, 'session')['alive'],
    rolledBack: existsSync(outer),
  }).toStrictEqual({ alive: true, rolledBack: false });
});

test('it keeps the files of a relative plain sub-session still starting when a workspace rolls back', async () => {
  await using ctx = await setupTest();

  const home = join(ctx.dir, 'box');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(home, 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
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
  const plain = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
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

  const plain = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const home = join(ctx.dir, 'box');

  mkdirSync(home, { recursive: true });

  ctx.port.setHomeDir(home);

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(home, 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
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

  const plain = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
    cwd: outer,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await tarHold.entered;

  const plain = await ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const outer = join(ctx.dir, 'box', 'a');

  ctx.port.setCommandFailure('tar -x');

  const spawn = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  ctx.port.setCommandFailure('tar -x');

  await ctx.client
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

  const retried = await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'a'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(getRecord(retried, 'session')['alive']).toBeTrue();
});

test("it removes a sub-session's checkout but keeps its parent and the files beside it when its start fails on the shared host", async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await ctx.client.sendRequest('session.spawn', {
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

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  await Promise.allSettled([spawn]);

  const listed = await ctx.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({ code: 'broker_not_ready' });

  expect<Record<string, unknown>>({
    exists: existsSync(dest),
    beside: readFileSync(join(ctx.dir, 'box', 'beside.txt'), 'utf8'),
    parentFiles: readFileSync(join(ctx.work, 'README.md'), 'utf8'),
    imps: ctx.port.collectImpNames(),
    state: ctx.port.findState(String(imp)),
    listed,
  }).toStrictEqual({
    exists: false,
    beside: 'kept\n',
    parentFiles: committed,
    imps: [imp],
    state: 'running',
    listed: { sessions: [expect.objectContaining({ id: parentID, alive: true })] },
  });
});

test('it spawns a sub-session again on the shared host after its failed start removed its checkout', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  // The imp the parent's spawn created, which the failed start must keep.
  const [imp] = ctx.port.collectImpNames();

  mkdirSync(join(ctx.dir, 'box'));
  writeFileSync(join(ctx.dir, 'box', 'beside.txt'), 'kept\n');

  ctx.port.startBrokerFailure();

  await ctx.client
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

  const retried = await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'child'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
  });

  const retriedID = getRecord(retried, 'session')['id'];

  const after = await ctx.client.sendRequest('session.list');

  expect<Record<string, unknown>>({
    beside: readFileSync(join(ctx.dir, 'box', 'beside.txt'), 'utf8'),
    parentFiles: readFileSync(join(ctx.work, 'README.md'), 'utf8'),
    imps: ctx.port.collectImpNames(),
    state: ctx.port.findState(String(imp)),
    retried: getRecord(retried, 'session')['alive'],
    listed: after,
  }).toStrictEqual({
    beside: 'kept\n',
    parentFiles: committed,
    imps: [imp],
    state: 'running',
    retried: true,
    listed: {
      sessions: expect.toIncludeSameMembers([
        expect.objectContaining({ id: parentID, alive: true }),
        expect.objectContaining({ id: retriedID, alive: true }),
      ]),
    },
  });
});

test("it removes a sub-session's checkout on its parent's sleeping host when its start fails there, then lets the host sleep again", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const [imp] = ctx.port.collectImpNames();
  const dest = join(ctx.dir, 'box', 'child');

  ctx.port.suspendWithForce(String(imp));

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('session.list');

    expect(listed).toMatchObject({
      sessions: [{ id: parentID, lifecycle: { vm: 'asleep' } }],
    });
  });

  ctx.port.startBrokerFailure();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'broker_not_ready' });

  expect<Record<string, unknown>>({
    exists: existsSync(dest),
    state: ctx.port.findState(String(imp)),
  }).toStrictEqual({ exists: false, state: 'sleeping' });
});

test("it answers outcome_unknown and logs the path of a sub-session's checkout it cannot remove when its start fails on the shared host", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
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

  const first = ctx.client.sendRequest('session.spawn', params);

  await first.catch(() => null);

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect<Record<string, unknown>>({
    exists: existsSync(join(dest, 'README.md')),
    logged: ctx.logs.filter((line) => line.startsWith(`atc: left ${dest} `)),
    listed: await ctx.client.sendRequest('session.list'),
  }).toStrictEqual({
    exists: true,
    logged: [expect.toEndWith('; remove it by hand')],
    listed: { sessions: [expect.objectContaining({ id: parentID, alive: true })] },
  });
});

test("it keeps the key of a sub-session's checkout it cannot remove, so a retry is answered outcome_unknown", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  ctx.port.startBrokerFailure();
  ctx.port.setCommandFailure('-mindepth');

  await ctx.client
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

  const retried = ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'glm',
    target: 'box',
    parent: parentID,
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await retried.catch(() => null);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect(ctx.logs.filter((line) => line.startsWith(`atc: left ${dest} `))).toStrictEqual([
    expect.toEndWith('; remove it by hand'),
  ]);
});

test("it keeps the claim on a sub-session's checkout it cannot remove, so a spawn inside it is refused", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  ctx.port.startBrokerFailure();
  ctx.port.setCommandFailure('-mindepth');

  await ctx.client
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

  const inside = ctx.client.sendRequest('session.spawn', {
    cwd: join(dest, 'inner'),
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await inside.catch(() => null);

  expect(inside).rejects.toMatchObject({ code: 'workspace_overlap' });

  expect<Record<string, unknown>>({
    exists: existsSync(join(dest, 'README.md')),
    listed: await ctx.client.sendRequest('session.list'),
  }).toStrictEqual({
    exists: true,
    listed: { sessions: [expect.objectContaining({ id: parentID, alive: true })] },
  });
});

test("it refuses a workspace destination that a symlink places inside its parent's directory before claiming it", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  symlinkSync(ctx.work, join(ctx.dir, 'alias'));

  const dest = join(ctx.dir, 'alias', 'new');

  const spawn = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const home = join(ctx.dir, 'home');

  mkdirSync(join(home, 'proj'), { recursive: true });

  ctx.port.setHomeDir(home);

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: 'proj',
    agent: 'glm',
    target: 'box',
  });

  const dest = join(home, 'proj', 'new');

  const spawn = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  mkdirSync(join(ctx.dir, 'elsewhere'));
  symlinkSync(join(ctx.dir, 'elsewhere'), join(ctx.dir, 'link'));

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'link', 'new'),
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  expect<Record<string, unknown>>({
    alive: getRecord(spawned, 'session')['alive'],
    readme: readFileSync(join(ctx.dir, 'elsewhere', 'new', 'README.md'), 'utf8'),
  }).toStrictEqual({ alive: true, readme: committed });
});

test('it answers outcome_unknown for a workspace spawn whose own host it cannot destroy after its workspace fails', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });

  ctx.port.setDestroyFailure('INTERNAL');

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: dest,
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'outcome_unknown' });
});

test('it keeps the key of a workspace spawn whose own host it cannot destroy as outcome_unknown, so a retry creates no imp', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'box', 'ws'), { recursive: true });

  ctx.port.setDestroyFailure('INTERNAL');

  await ctx.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      agent: 'plain',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'k-1',
    })
    .catch(() => null);

  const retried = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  ctx.port.setAcquireFailure(0, 'INTERNAL');
  ctx.port.setDestroyFailure('INTERNAL');

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'outcome_unknown' });
});

test('it keeps the key of a spawn whose failed readying leaves an imp it cannot destroy as outcome_unknown, so a retry creates no imp', async () => {
  await using ctx = await setupTest();

  ctx.port.setAcquireFailure(0, 'INTERNAL');
  ctx.port.setDestroyFailure('INTERNAL');

  await ctx.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      agent: 'plain',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'k-1',
    })
    .catch(() => null);

  const retried = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  ctx.port.setAcquireFailure(0, 'INTERNAL');

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    agent: 'plain',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    idempotencyKey: 'k-1',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'host_unavailable' });
  expect(ctx.port.collectImpNames()).toStrictEqual([]);
});

test('it keeps the files of a session listed inside its directory while a workspace rollback resolves the host', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  const parentID = getRecord(parent, 'session')['id'];
  const outer = join(ctx.dir, 'box', 'a');
  const tarHold = ctx.port.startCommandHold('tar -x');

  const outerSpawn = ctx.client.sendRequest('session.spawn', {
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

  await ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
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
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const busy = join(ctx.dir, 'busy');

  mkdirSync(join(busy, 'sub'), { recursive: true });
  mkdirSync(join(busy, 'sub\n'));
  symlinkSync(join(busy, 'sub\n'), join(ctx.dir, 'alias'));

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: join(busy, 'sub'),
    agent: 'glm',
    target: 'box',
  });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'alias', 'new'),
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
    workspace: { kind: 'path', path: ctx.work },
  });

  expect<Record<string, unknown>>({
    alive: getRecord(spawned, 'session')['alive'],
    readme: readFileSync(join(busy, 'sub\n', 'new', 'README.md'), 'utf8'),
    untouched: existsSync(join(busy, 'sub', 'new')),
  }).toStrictEqual({ alive: true, readme: committed, untouched: false });
});

test('it removes only the directory it created when a symlink in the requested path changes before a rollback', async () => {
  await using ctx = await setupTest();

  const safe = join(ctx.dir, 'safe');
  const busy = join(ctx.dir, 'busy');
  const alias = join(ctx.dir, 'alias');

  mkdirSync(safe);
  mkdirSync(join(busy, 'new', 'inner'), { recursive: true });
  writeFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'kept\n');
  symlinkSync(safe, alias);

  const tarHold = ctx.port.startCommandHold('tar -x');

  const spawn = ctx.client.sendRequest('session.spawn', {
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

  expect<Record<string, unknown>>({
    kept: readFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'utf8'),
    exists: existsSync(join(safe, 'new')),
  }).toStrictEqual({ kept: 'kept\n', exists: false });
});

test('it leaves its directory and reports it when the directory it created no longer resolves to itself before a rollback', async () => {
  await using ctx = await setupTest();

  const safe = join(ctx.dir, 'safe');
  const busy = join(ctx.dir, 'busy');

  mkdirSync(safe);
  mkdirSync(join(busy, 'new', 'inner'), { recursive: true });
  writeFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'kept\n');

  const tarHold = ctx.port.startCommandHold('tar -x');

  const spawn = ctx.client.sendRequest('session.spawn', {
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

  expect<Record<string, unknown>>({
    kept: readFileSync(join(busy, 'new', 'inner', 'keep.txt'), 'utf8'),
    left: existsSync(join(ctx.dir, 'safe-old', 'new')),
  }).toStrictEqual({ kept: 'kept\n', left: true });
});
