import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubBrokeredAgentAdapter } from '../test-utils/build-stub-brokered-agent-adapter';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';
import { RuntimeAuthBinder } from './runtime-auth-binder';

/**
 * A real daemon with a `local` target and an imp target `box`, the
 * default, over a fixture imp port whose impd an operator prepared: the
 * token `atc-runtime` manages `atc-*` imps and may grant `glm`, and impd
 * holds `glm` for api.z.ai as a custom bearer secret. The agent `glm`
 * takes that credential from the broker and plans a guest spawn that
 * prints the binding revision it launches under; `proxied` takes the same
 * credential but plans a proxy variable; `subscription` takes it on a
 * target that reaches the broker and starts without it elsewhere; `plain`
 * takes none. The principal `ops` may use `box`. `restart` stops the
 * daemon and starts another on the same state, `setAuthSelected` turns the
 * broker credential of `glm` off and on, `withStore` runs a read or write
 * against the daemon's state store, and `getImpName` returns the name of
 * the only imp impd holds.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-runtime-auth-'));
  const port = stack.use(new FixtureImpPort());

  // A brokered spawn needs a token that may grant the agent's secret, and
  // the secret itself.
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

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  stack.defer(() => {
    provider.dispose();
  });

  let authSelected = true;

  const brokered = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => authSelected,
  });

  const harness = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: brokered,
      adapters: [
        brokered,
        buildMockAgentAdapter({ id: 'plain' }),
        {
          ...buildStubBrokeredAgentAdapter({
            id: 'proxied',
            brokerRequired: true,
            isSelected: () => true,
          }),
          planGuestSpawn: () => ({
            bin: 'sleep',
            args: ['30'],
            files: {},
            env: { https_proxy: 'http://proxy.example:3128' },
          }),
        },
        buildStubBrokeredAgentAdapter({
          id: 'subscription',
          brokerRequired: false,
          isSelected: () => true,
        }),
      ],
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
      defaultTarget: 'box',
      principals: new Map([['ops', ['box']]]),
      forgetConfirmMs: 60_000,
    }),
  });

  stack.use(harness);

  const owned = stack.move();

  return {
    get client() {
      return harness.client;
    },
    port,
    provider,
    dir: tmp.dir,
    setAuthSelected(selected: boolean): void {
      authSelected = selected;
    },
    restart: () => harness.restart(),
    async withStore<T>(run: (store: StateStore) => Promise<T>): Promise<T> {
      await using held = new AsyncDisposableStack();

      const store = await StateStore.open(harness.dbPath);

      held.defer(() => store.stop());

      return await run(store);
    },
    getImpName(): string {
      const names = port.collectImpNames();
      const [name] = names;

      if (names.length !== 1 || name === undefined) {
        throw new Error(`expected one imp, found ${JSON.stringify(names)}`);
      }

      return name;
    },
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it provisions the host of a spawn before readying it and starts the harness only behind a ready broker', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = ctx.getImpName();

  const binding = await ctx.withStore((store) => store.findAuthBinding(toSessionID(id)));

  expect<Record<string, unknown>>({
    calls: ctx.port.calls.filter((call) => !call.startsWith('leases.renew')),
    require: ctx.port.sessionRequests.map((request) =>
      request.kind === 'start' ? request.require : null,
    ),
    grants: await ctx.port.readGrants(imp),
    binding,
  }).toStrictEqual({
    calls: [
      'system.info',
      'tokens.whoami',
      'secrets.list',
      `imps.get ${imp}`,
      `imps.create ${imp}`,
      `grants.list ${imp}`,
      `grants.add ${imp} glm`,
      'system.info',
      `imps.get ${imp}`,
      expect.toStartWith(`leases.acquire ${imp} `),
      expect.toStartWith(`exec.run ${imp} sh -c mkdir`),
      expect.toStartWith(`reverse ${imp} `),
      'system.info',
      expect.toStartWith(`exec.start ${imp} `),
    ],
    require: [['broker']],
    grants: ['glm'],
    binding: expect.objectContaining({ state: 'ready', revision: 1, impName: imp }),
  });
});

test('it lists the imp target as reaching the broker and the local target as reaching none', async () => {
  await using ctx = await setupTest();

  const listed = await ctx.client.sendRequest('agents.list');

  expect(listed['targets']).toStrictEqual([
    {
      id: 'local',
      provider: 'local-pty',
      identity: 'local-pty:test',
      available: true,
      default: false,
      capabilities: {
        spawn: true,
        attach: true,
        input: true,
        resize: true,
        kill: true,
        transfer: true,
        run: true,
        headless: true,
        suspend: false,
        destroy: false,
      },
      brokerAuth: false,
    },
    {
      id: 'box',
      provider: 'imp',
      identity: 'imp:test',
      available: true,
      default: true,
      capabilities: {
        spawn: true,
        attach: true,
        input: true,
        resize: true,
        kill: true,
        transfer: true,
        run: true,
        headless: false,
        suspend: true,
        destroy: true,
      },
      brokerAuth: true,
    },
  ]);
});

test('it lists an agent that takes the broker credential as spawnable on a daemon with a broker target', async () => {
  await using ctx = await setupTest();

  const listed = await ctx.client.sendRequest('agents.list');

  expect(listed['agents']).toStrictEqual([
    {
      id: 'glm',
      label: 'GLM',
      kind: 'claude',
      installed: true,
      brokerAuth: true,
      brokerRequired: true,
      capabilities: {
        spawn: true,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          available: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          available: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
    {
      id: 'plain',
      label: 'plain',
      kind: 'plain',
      installed: false,
      brokerAuth: false,
      brokerRequired: false,
      capabilities: {
        spawn: false,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          available: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          available: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
    {
      id: 'proxied',
      label: 'GLM',
      kind: 'claude',
      installed: true,
      brokerAuth: true,
      brokerRequired: true,
      capabilities: {
        spawn: true,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          available: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          available: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
    {
      id: 'subscription',
      label: 'GLM',
      kind: 'claude',
      installed: true,
      brokerAuth: true,
      brokerRequired: false,
      capabilities: {
        spawn: true,
        readTranscript: false,
        message: false,
        attach: true,
        screen: true,
        input: true,
      },
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          available: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          available: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
  ]);
});

test('it starts a brokered harness with the variables its guest plan holds beside the ones atc sets', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const [start] = ctx.port.sessionRequests;

  if (start?.kind !== 'start') {
    throw new Error('expected the harness start');
  }

  expect(start.env).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
    CLAUDE_CONFIG_DIR: expect.toEndWith(`/sessions/${id}/claude-config`),
    ATC_SESSION_ID: id,
  });
});

test('it refuses a brokered spawn whose guest plan sets a proxy variable before touching impd', async () => {
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'proxied',
    target: 'box',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { problem: 'guest_env_conflict', variable: 'https_proxy' },
  });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    listed: await ctx.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: [], listed: { sessions: [] } });
});

test('it refuses a spawn on an impd without exec requirements after reading only its features', async () => {
  await using ctx = await setupTest();

  ctx.port.features = { ...ctx.port.features, execRequire: false };

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'auth_impd_too_old' });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    listed: await ctx.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: ['system.info'], listed: { sessions: [] } });
});

test('it refuses a spawn whose broker is not ready, takes back its imp, and lists no session', async () => {
  await using ctx = await setupTest();

  ctx.port.startBrokerFailure();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  await spawn.catch(() => null);

  const bindings = await ctx.withStore((store) => store.collectAuthBindings());

  expect(spawn).rejects.toMatchObject({
    code: 'broker_not_ready',
    data: { detail: 'the broker CA did not install' },
  });

  expect<Record<string, unknown>>({
    imps: ctx.port.collectImpNames(),
    bindings,
    listed: await ctx.client.sendRequest('session.list'),
  }).toStrictEqual({ imps: [], bindings: [], listed: { sessions: [] } });
});

test('it refuses a spawn with runtime auth on the local target before touching impd', async () => {
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it starts an agent that takes the broker credential only where a broker is on the local target without touching impd', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'subscription',
    target: 'local',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const binding = await ctx.withStore((store) => store.findAuthBinding(toSessionID(id)));

  expect<Record<string, unknown>>({ calls: ctx.port.calls, binding }).toStrictEqual({
    calls: [],
    binding: null,
  });
});

test('it binds an agent that takes the broker credential only where a broker is on an imp target and starts it behind the broker', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'subscription',
    target: 'box',
  });

  const imp = ctx.getImpName();

  expect<Record<string, unknown>>({
    require: ctx.port.sessionRequests.map((request) =>
      request.kind === 'start' ? request.require : null,
    ),
    grants: await ctx.port.readGrants(imp),
  }).toStrictEqual({ require: [['broker']], grants: ['glm'] });
});

test.each([
  ['a spawn', false],
  ['a resume', 'a1'],
] as const)(
  'it refuses %s of a brokered agent with a workspace on the local target before materializing it',
  async (_kind, resume) => {
    await using ctx = await setupTest();

    const cwd = join(ctx.dir, 'ws');

    const spawn = ctx.client.sendRequest('session.spawn', {
      cwd,
      agent: 'glm',
      target: 'local',
      resume,
      workspace: { kind: 'path', path: join(ctx.dir, 'source') },
    });

    await spawn.catch(() => null);

    expect(spawn).rejects.toMatchObject({
      code: 'auth_target_unsupported',
      data: { agent: 'glm', target: 'local' },
    });

    expect<Record<string, unknown>>({
      calls: ctx.port.calls,
      created: await Bun.file(cwd).exists(),
      listed: await ctx.client.sendRequest('session.list'),
    }).toStrictEqual({ calls: [], created: false, listed: { sessions: [] } });
  },
);

test('it refuses to adopt a local session with a workspace once its agent takes the broker credential', async () => {
  await using ctx = await setupTest();

  ctx.setAuthSelected(false);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
    resume: 'a1',
  });

  const id = toSessionID(String(getRecord(spawned, 'session')['id']));

  await ctx.client.sendRequest('session.kill', { session: id });

  const recorded = await ctx.withStore(async (store) => {
    await store.createMaterialization(
      { sessionID: id, target: 'local', dir: ctx.dir, sourceKind: 'path', withheldEnv: [] },
      Date.now(),
    );

    await store.updateMaterialization(
      id,
      {
        phase: 'ready',
        repoURL: 'file:///src',
        sha: 'a'.repeat(40),
        ref: 'main',
        materializedAt: 1,
      },
      Date.now(),
    );

    return store.findMaterialization(id);
  });

  ctx.setAuthSelected(true);

  await ctx.restart();
  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  const materialization = await ctx.withStore((store) => store.findMaterialization(id));
  const got = await ctx.client.sendRequest('session.get', { session: id });

  expect(adopt).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', target: 'local' },
  });

  expect<Record<string, unknown>>({
    session: getRecord(got, 'session'),
    materialization,
    calls: ctx.port.calls,
  }).toStrictEqual({
    session: expect.objectContaining({
      state: 'exited',
      alive: false,
      workspace: { repoURL: 'file:///src', sha: 'a'.repeat(40), ref: 'main', materializedAt: 1 },
    }),
    materialization: recorded,
    calls: [],
  });
});

test('it restores a local session with a workspace without a terminal once its agent takes the broker credential', async () => {
  await using ctx = await setupTest();

  ctx.setAuthSelected(false);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
    resume: 'a1',
  });

  const id = toSessionID(String(getRecord(spawned, 'session')['id']));

  const recorded = await ctx.withStore(async (store) => {
    await store.createMaterialization(
      { sessionID: id, target: 'local', dir: ctx.dir, sourceKind: 'path', withheldEnv: [] },
      Date.now(),
    );

    await store.updateMaterialization(
      id,
      {
        phase: 'ready',
        repoURL: 'file:///src',
        sha: 'a'.repeat(40),
        ref: 'main',
        materializedAt: 1,
      },
      Date.now(),
    );

    return store.findMaterialization(id);
  });

  ctx.setAuthSelected(true);

  await ctx.restart();
  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const materialization = await ctx.withStore((store) => store.findMaterialization(id));
  const got = await ctx.client.sendRequest('session.get', { session: id });

  expect<Record<string, unknown>>({
    session: getRecord(got, 'session'),
    materialization,
    calls: ctx.port.calls,
  }).toStrictEqual({
    session: expect.objectContaining({
      kind: 'headless',
      lastMsg: 'waiting to restore',
      workspace: { repoURL: 'file:///src', sha: 'a'.repeat(40), ref: 'main', materializedAt: 1 },
    }),
    materialization: recorded,
    calls: [],
  });
});

test('it refuses to revive a session whose agent dropped the broker credential while its host holds a binding', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.auth.revoke', { session: id });

  ctx.setAuthSelected(false);

  ctx.port.calls.length = 0;

  const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  expect(adopt).rejects.toMatchObject({
    code: 'auth_rebind_required',
    data: { agent: 'glm', state: 'revoked' },
  });

  expect(ctx.port.calls).toStrictEqual([]);
});

test('it revives a session whose agent takes no broker credential on a host that holds no binding', async () => {
  await using ctx = await setupTest();

  ctx.setAuthSelected(false);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(
    ctx.port.sessionRequests.map((request) =>
      request.kind === 'start' ? (request.require ?? null) : request.kind,
    ),
  ).toStrictEqual([null, null]);
});

test('it restores a session whose agent dropped the broker credential while its host holds a binding without a terminal', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.auth.revoke', { session: id });

  ctx.setAuthSelected(false);

  await ctx.restart();

  const before = ctx.port.sessionRequests.length;

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await ctx.client.sendRequest('session.get', { session: id });

  expect<Record<string, unknown>>({
    sent: ctx.port.sessionRequests.length - before,
    session: getRecord(got, 'session'),
  }).toStrictEqual({
    sent: 0,
    session: expect.objectContaining({ kind: 'headless', lastMsg: 'waiting to restore' }),
  });
});

test('it restores a session whose agent takes no broker credential on a host that holds no binding', async () => {
  await using ctx = await setupTest();

  ctx.setAuthSelected(false);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.restart();

  const before = ctx.port.sessionRequests.length;

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await ctx.client.sendRequest('session.get', { session: id });

  expect<Record<string, unknown>>({
    sent: ctx.port.sessionRequests.length - before,
    session: getRecord(got, 'session'),
  }).toStrictEqual({ sent: 1, session: expect.objectContaining({ kind: 'pty' }) });
});

test('it refuses a revive that a revoke blocks while its host wakes, sending no start', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = ctx.getImpName();

  await ctx.client.sendRequest('session.kill', { session: id });

  ctx.port.startLeaseHold();

  ctx.port.calls.length = 0;

  const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = ctx.client.sendRequest('session.auth.revoke', { session: id });

  await revoke.catch(() => null);

  ctx.port.stopLeaseHold();

  await adopt.catch(() => null);

  await waitFor(() => {
    expect(ctx.port.findState(imp)).toBe('sleeping');
  });

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  expect(adopt).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { state: 'revocation_pending' },
  });

  expect<Record<string, unknown>>({
    starts: ctx.port.sessionRequests.length,
    grants: await ctx.port.readGrants(imp),
  }).toStrictEqual({ starts: 1, grants: ['glm'] });
});

test('it refuses a sub-session spawn that a revoke blocks while it readies the shared host, sending no start', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = ctx.getImpName();

  ctx.port.startLeaseHold();

  ctx.port.calls.length = 0;

  const child = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = ctx.client.sendRequest('session.auth.revoke', { session: parentID });

  await revoke.catch(() => null);

  ctx.port.stopLeaseHold();

  await child.catch(() => null);

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  expect(child).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { state: 'revocation_pending' },
  });

  expect(ctx.port.sessionRequests).toHaveLength(1);
});

test('it puts a shared host back to sleep when a revoke refuses the sub-session that woke it, keeping the imp and its grant', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = ctx.getImpName();

  await ctx.client.sendRequest('session.kill', { session: parentID });

  await waitFor(() => {
    expect(ctx.port.findState(imp)).toBe('sleeping');
  });

  ctx.port.startLeaseHold();

  ctx.port.calls.length = 0;

  const child = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  await ctx.client.sendRequest('session.auth.revoke', { session: parentID }).catch(() => null);

  ctx.port.stopLeaseHold();

  await child.catch(() => null);

  await waitFor(() => {
    expect(ctx.port.findState(imp)).toBe('sleeping');
  });

  expect(child).rejects.toMatchObject({ code: 'auth_blocked' });

  expect<Record<string, unknown>>({
    destroyed: ctx.port.calls.filter((call) => call.startsWith('imps.destroy')),
    grants: await ctx.port.readGrants(imp),
  }).toStrictEqual({ destroyed: [], grants: ['glm'] });
});

test('it keeps a shared host awake when a revoke refuses a sub-session while another harness runs there', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = ctx.getImpName();

  ctx.port.startLeaseHold();

  ctx.port.calls.length = 0;

  const child = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  await ctx.client.sendRequest('session.auth.revoke', { session: parentID }).catch(() => null);

  ctx.port.stopLeaseHold();

  await child.catch(() => null);

  expect(child).rejects.toMatchObject({ code: 'auth_blocked' });

  expect<Record<string, unknown>>({
    state: ctx.port.findState(imp),
    sleeps: ctx.port.calls.filter((call) => call.startsWith('imps.sleep')),
  }).toStrictEqual({ state: 'running', sleeps: [] });
});

test('it keeps a host awake for a sub-session that readies it while a refused revive puts it to sleep', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = ctx.getImpName();

  await ctx.client.sendRequest('session.kill', { session: parentID });

  ctx.port.startBrokerFailure();
  ctx.port.startReleaseHold();

  ctx.port.calls.length = 0;

  const revive = ctx.client.sendRequest('session.adopt', {
    session: parentID,
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.startsWith('leases.release'))).toHaveLength(1);
  });

  ctx.port.stopBrokerFailure();

  const child = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.startsWith(`grants.list ${imp}`))).toHaveLength(2);
  });

  ctx.port.stopReleaseHold();

  await revive.catch(() => null);

  const spawnedChild = await child;

  const childID = String(getRecord(spawnedChild, 'session')['id']);

  const got = await ctx.client.sendRequest('session.get', { session: childID });

  expect(revive).rejects.toMatchObject({ code: 'broker_not_ready' });

  expect<Record<string, unknown>>({
    sleeps: ctx.port.calls.filter((call) => call.startsWith('imps.sleep')),
    state: ctx.port.findState(imp),
    child: getRecord(got, 'session'),
  }).toStrictEqual({
    sleeps: [],
    state: 'running',
    child: expect.objectContaining({ kind: 'pty', alive: true }),
  });
});

test('it puts a host to sleep after a refused revive when no other launch readies it', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = ctx.getImpName();

  await ctx.client.sendRequest('session.kill', { session: parentID });

  ctx.port.startBrokerFailure();
  ctx.port.startReleaseHold();

  ctx.port.calls.length = 0;

  const revive = ctx.client.sendRequest('session.adopt', {
    session: parentID,
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.startsWith('leases.release'))).toHaveLength(1);
  });

  ctx.port.stopReleaseHold();

  await revive.catch(() => null);

  await waitFor(() => {
    expect(ctx.port.findState(imp)).toBe('sleeping');
  });

  expect(revive).rejects.toMatchObject({ code: 'broker_not_ready' });
  expect(ctx.port.calls.filter((call) => call.startsWith('imps.sleep'))).toHaveLength(1);
});

test('it spawns a sub-session on the shared host while it readies when no revoke comes between', async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = ctx.getImpName();

  ctx.port.startLeaseHold();

  ctx.port.calls.length = 0;

  const child = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.stopLeaseHold();

  await child;

  expect(ctx.port.sessionRequests).toHaveLength(2);
});

test('it sends no start for a revive that a revoke blocks while its connection to impd opens', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = ctx.getImpName();

  await ctx.client.sendRequest('session.kill', { session: id });

  ctx.port.startUpgradeHold();

  const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.countHeldUpgrades()).toBe(1);
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = ctx.client.sendRequest('session.auth.revoke', { session: id });

  await revoke.catch(() => null);

  ctx.port.stopUpgradeHold();

  await adopt.catch(() => null);

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  expect(adopt).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { state: 'revocation_pending' },
  });

  expect<Record<string, unknown>>({
    starts: ctx.port.sessionRequests.length,
    grants: await ctx.port.readGrants(imp),
  }).toStrictEqual({ starts: 1, grants: ['glm'] });
});

test('it sends the start of a revive whose connection to impd opens late when no revoke comes between', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });

  ctx.port.startUpgradeHold();

  const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.countHeldUpgrades()).toBe(1);
  });

  ctx.port.stopUpgradeHold();

  await adopt;

  expect(ctx.port.sessionRequests).toHaveLength(2);
});

test('it revives a session while its host wakes when no revoke comes between', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = ctx.getImpName();

  await ctx.client.sendRequest('session.kill', { session: id });

  ctx.port.startLeaseHold();

  const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.stopLeaseHold();

  await adopt;

  expect(ctx.port.sessionRequests).toHaveLength(2);
});

test('it revives a slept session after verifying its binding, granting nothing again', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = ctx.getImpName();

  await ctx.client.sendRequest('session.kill', { session: id });

  ctx.port.calls.length = 0;

  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls.filter((call) => !call.startsWith('leases.renew')),
    require: ctx.port.sessionRequests.map((request) =>
      request.kind === 'start' ? request.require : null,
    ),
  }).toStrictEqual({
    calls: [
      'system.info',
      'tokens.whoami',
      'secrets.list',
      `imps.get ${imp}`,
      `grants.list ${imp}`,
      'system.info',
      `imps.get ${imp}`,
      expect.toStartWith(`leases.acquire ${imp} `),
      expect.toStartWith(`exec.run ${imp} sh -c mkdir`),
      expect.toStartWith(`reverse ${imp} `),
      'system.info',
      expect.toStartWith(`exec.start ${imp} `),
    ],
    require: [['broker'], ['broker']],
  });
});

test('it refuses to revive a session whose grant was revoked outside atc and grants it no more', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = ctx.getImpName();

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.port.removeGrant(imp, 'glm');

  ctx.port.calls.length = 0;

  const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  expect(adopt).rejects.toMatchObject({ code: 'auth_grant_missing' });

  expect<Record<string, unknown>>({
    starts: ctx.port.sessionRequests.length,
    granted: ctx.port.calls.filter((call) => call.startsWith('grants.add')),
    state: ctx.port.findState(imp),
  }).toStrictEqual({ starts: 1, granted: [], state: 'sleeping' });
});

test('it refuses to revive a session whose broker is not ready and puts its host back to sleep', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = ctx.getImpName();

  await ctx.client.sendRequest('session.kill', { session: id });

  ctx.port.startBrokerFailure();

  const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  const listed = await ctx.client.sendRequest('session.list');

  expect(adopt).rejects.toMatchObject({ code: 'broker_not_ready' });

  expect<Record<string, unknown>>({ state: ctx.port.findState(imp), listed }).toMatchObject({
    state: 'sleeping',
    listed: {
      sessions: [
        {
          id,
          alive: false,
          lastMsg: 'imp broker not ready (the broker CA did not install)',
          lifecycle: { vm: 'asleep' },
        },
      ],
    },
  });
});

test('it provisions concurrent spawns each in an imp of its own with only its own grant', async () => {
  await using ctx = await setupTest();

  const spawned = await Promise.all([
    ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'glm', target: 'box' }),
    ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'glm', target: 'box' }),
  ]);

  const imps = ctx.port.collectImpNames();

  const grants = await Promise.all(imps.map((imp) => ctx.port.readGrants(imp)));
  const bindings = await ctx.withStore((store) => store.collectAuthBindings());

  expect<Record<string, unknown>>({
    imps,
    grants,
    hostKeys: bindings.map((binding) => binding.hostKey),
    impNames: bindings.map((binding) => binding.impName),
    states: bindings.map((binding) => binding.state),
  }).toStrictEqual({
    imps: [expect.stringMatching(/^atc-[\da-f]{20}$/), expect.stringMatching(/^atc-[\da-f]{20}$/)],
    grants: [['glm'], ['glm']],
    hostKeys: expect.toIncludeSameMembers(
      spawned.map((answer) => getRecord(answer, 'session')['id']),
    ),
    impNames: expect.toIncludeSameMembers(imps),
    states: ['ready', 'ready'],
  });
});

test('it revokes the grants of a running session while its harness keeps running', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = ctx.getImpName();

  const revoked = await ctx.client.sendRequest('session.auth.revoke', { session: id });
  const listed = await ctx.client.sendRequest('session.list');

  expect<Record<string, unknown>>({
    revoked,
    grants: await ctx.port.readGrants(imp),
    listed,
  }).toStrictEqual({
    revoked: { revoked: true },
    grants: [],
    listed: { sessions: [expect.objectContaining({ id, alive: true })] },
  });
});

test('it refuses to revive a session revoked while it slept', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.auth.revoke', { session: id });

  const adopt = ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  expect(adopt).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });
  expect(ctx.port.sessionRequests).toHaveLength(1);
});

test('it rebinds a revoked session so it revives under the next revision', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.client.sendRequest('session.auth.revoke', { session: id });

  const rebound = await ctx.client.sendRequest('session.auth.rebind', { session: id });

  await ctx.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect<Record<string, unknown>>({
    rebound,
    argv: ctx.port.sessionRequests.map((request) =>
      request.kind === 'start' ? request.argv.at(-1) : null,
    ),
  }).toStrictEqual({
    rebound: { revision: 2 },
    argv: ['echo "revision 1"; exec sleep 30', 'echo "revision 2"; exec sleep 30'],
  });
});

test('it refuses session.auth.revoke from a principal as unauthorized and revokes nothing', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = ctx.getImpName();
  const revoke = ctx.client.sendRequest('session.auth.revoke', { session: id }, 'ops');

  await revoke.catch(() => null);

  const grants = await ctx.port.readGrants(imp);

  expect(revoke).rejects.toMatchObject({ code: 'unauthorized' });
  expect(grants).toStrictEqual(['glm']);
});

test('it refuses session.auth.rebind from a principal as unauthorized and binds nothing', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  ctx.port.calls.length = 0;

  const rebind = ctx.client.sendRequest('session.auth.rebind', { session: id }, 'ops');

  await rebind.catch(() => null);

  expect(rebind).rejects.toMatchObject({ code: 'unauthorized' });
  expect(ctx.port.calls.filter((call) => !call.startsWith('leases.renew'))).toStrictEqual([]);
});

test('it forgets a bound session by destroying its imp and dropping its binding, never a secret', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const offered = await ctx.client.sendRequest('session.forget', { session: id });

  await ctx.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  const bindings = await ctx.withStore((store) => store.collectAuthBindings());
  const secrets = await ctx.port.readSecrets();

  expect<Record<string, unknown>>({
    imps: ctx.port.collectImpNames(),
    secrets: secrets.map((secret) => secret.name),
    bindings,
  }).toStrictEqual({ imps: [], secrets: ['glm'], bindings: [] });
});

test("it runs a sub-session under the same binding in its parent's imp without granting again", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  ctx.port.calls.length = 0;

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  expect<Record<string, unknown>>({
    imps: ctx.port.collectImpNames(),
    created: ctx.port.calls.filter(
      (call) => call.startsWith('imps.create') || call.startsWith('grants.add'),
    ),
    require: ctx.port.sessionRequests.map((request) =>
      request.kind === 'start' ? request.require : null,
    ),
  }).toStrictEqual({
    imps: [expect.any(String)],
    created: [],
    require: [['broker'], ['broker']],
  });
});

test("it refuses a sub-session without runtime auth in a bound parent's imp", async () => {
  await using ctx = await setupTest();

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'plain',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'auth_binding_mismatch' });
  expect(ctx.port.sessionRequests).toHaveLength(1);
});

test('it takes back, as it starts, a spawn a stopped daemon left provisioning', async () => {
  await using ctx = await setupTest();

  await ctx.withStore(async (store) => {
    await new RuntimeAuthBinder(store).createBinding(ctx.provider.brokerAuth, {
      hostKey: toSessionID('orphan'),
      target: 'box',
      targetIdentity: 'imp:test',
      binding: {
        agent: 'glm',
        baseURL: 'https://api.z.ai/api/anthropic',
        profiles: ['glm'],
        secrets: [
          {
            secret: 'glm',
            kind: 'custom',
            rules: [{ host: 'api.z.ai', header: 'authorization', scheme: 'bearer' }],
          },
        ],
        placeholderEnv: {},
        profileEnv: {},
        hash: 'h1',
      },
    });
  });

  ctx.port.calls.length = 0;

  await ctx.restart();

  await waitFor(() => {
    expect(ctx.port.collectImpNames()).toStrictEqual([]);
  });

  expect(ctx.port.calls).toStrictEqual([
    'tokens.whoami',
    'imps.get atc-orphan',
    'imps.destroy atc-orphan',
    'imps.get atc-orphan',
  ]);
});

test('it restores a session whose broker is not ready without a terminal', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.restart();

  ctx.port.startBrokerFailure();

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await ctx.client.sendRequest('session.list');

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id, alive: false })],
  });
});
