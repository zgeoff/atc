import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { startDaemon } from './daemon';
import type { DaemonHandle } from './daemon';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';
import { RuntimeAuthBinder } from './runtime-auth-binder';

/**
 * A real daemon with a `local` target and an imp target `box` over a
 * fixture imp port, whose impd an operator prepared: the token
 * `atc-runtime` manages `atc-*` imps and may grant `glm`, and impd holds
 * `glm` for api.z.ai as a custom bearer secret. The agent `glm` takes that
 * credential from the broker and plans a guest spawn that prints the
 * binding revision it launches under, or a plain one without the broker, with its placeholder and its own
 * config folder in the harness's variables; `proxied` takes the same
 * credential but plans a proxy variable; `subscription` takes it on a
 * target that reaches the broker and starts without it elsewhere; `plain`
 * takes none. The principal
 * `ops` may use `box`. `restart` stops the daemon and starts another on
 * the same state, and `setAuthSelected` turns the broker credential of
 * `glm` off and on.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-runtime-auth-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const dbPath = join(tmp.dir, 'state.db');

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

  let authSelected = true;

  const shared = {
    headlessRunner: null,
    screenDetector: null,
    takesMessages: false,
    normalizeHook: () => ({ kind: 'heartbeat' }) as const,
    loadName: () => Promise.resolve(null),
    canResume: () => true,
    buildResumeCommand: () => null,
  };

  const brokered: AgentAdapter = {
    ...shared,
    id: 'glm',
    profile: {
      label: 'GLM',
      kind: 'claude',
      bin: 'sh',
      models: null,
      spawnOptions: {
        model: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
        effort: {
          supported: false,
          values: null,
          examples: [],
          default: null,
          backendEffect: null,
          note: null,
        },
      },
    },
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
    planGuestSpawn: (_opts, guest) =>
      guest.auth === undefined
        ? { bin: 'sleep', args: ['30'], files: {} }
        : {
            bin: 'sh',
            args: ['-c', `echo "revision ${String(guest.auth.revision)}"; exec sleep 30`],
            files: {},
            env: { ...guest.auth.env, CLAUDE_CONFIG_DIR: `${guest.dir}/claude-config` },
          },
    findAuthSelection: () =>
      authSelected
        ? {
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
          }
        : null,
  };

  const plain: AgentAdapter = {
    ...shared,
    id: 'plain',
    planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  };

  const proxied: AgentAdapter = {
    ...brokered,
    id: 'proxied',
    planGuestSpawn: () => ({
      bin: 'sleep',
      args: ['30'],
      files: {},
      env: { https_proxy: 'http://proxy.example:3128' },
    }),
  };

  const subscription: AgentAdapter = {
    ...brokered,
    id: 'subscription',
    findAuthSelection: () => {
      const selection = brokered.findAuthSelection?.() ?? null;

      return selection === null ? null : { ...selection, brokerRequired: false };
    },
  };

  const start = (): Promise<DaemonHandle> =>
    startDaemon({
      socketPath: sockPath,
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: brokered,
      adapters: [brokered, plain, proxied, subscription],
      dbPath,
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
      defaultTarget: 'box',
      principals: new Map([['ops', ['box']]]),
      forgetConfirmMs: 60_000,
    });

  let daemon = await start();
  let client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    get client() {
      return client;
    },
    port,
    provider,
    dbPath,
    dir: tmp.dir,

    // Whether `glm` takes its credential from the broker, as a config
    // change can turn on for an agent whose sessions already exist.
    setAuthSelected(selected: boolean): void {
      authSelected = selected;
    },
    async restart(): Promise<void> {
      client.stop();

      await daemon.stop();

      daemon = await start();
      client = await DaemonClient.open(sockPath);

      await client.sendHello('atc/test-build');
    },
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      provider.dispose();
      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it provisions the host of a spawn before readying it and starts the harness only behind a ready broker', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;

  const store = await StateStore.open(daemon.dbPath);
  const binding = await store.findAuthBinding(toSessionID(id));

  await store.stop();

  expect<Record<string, unknown>>({
    calls: daemon.port.calls.filter((call) => !call.startsWith('leases.renew')),
    require: daemon.port.sessionRequests.map((request) =>
      request.kind === 'start' ? request.require : null,
    ),
    grants: await daemon.port.readGrants(imp),
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
  await using daemon = await setupTest();

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed['targets']).toMatchObject([
    { id: 'local', brokerAuth: false },
    { id: 'box', brokerAuth: true },
  ]);
});

test('it lists an agent that takes the broker credential as spawnable on a daemon with a broker target', async () => {
  await using daemon = await setupTest();

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed).toMatchObject({
    agents: [
      { id: 'glm', brokerAuth: true, capabilities: { spawn: true } },
      { id: 'plain' },
      {},
      { id: 'subscription', brokerAuth: true, brokerRequired: false },
    ],
  });
});

test('it starts a brokered harness with the variables its guest plan holds beside the ones atc sets', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const [start] = daemon.port.sessionRequests;

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
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'proxied',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { problem: 'guest_env_conflict', variable: 'https_proxy' },
  });

  await spawn.catch(() => null);

  expect<Record<string, unknown>>({
    calls: daemon.port.calls,
    listed: await daemon.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: [], listed: { sessions: [] } });
});

test('it refuses a spawn on an impd without exec requirements after reading only its features', async () => {
  await using daemon = await setupTest();

  daemon.port.features = { ...daemon.port.features, execRequire: false };

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_impd_too_old' });

  await spawn.catch(() => null);

  expect<Record<string, unknown>>({
    calls: daemon.port.calls,
    listed: await daemon.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: ['system.info'], listed: { sessions: [] } });
});

test('it refuses a spawn whose broker is not ready, takes back its imp, and lists no session', async () => {
  await using daemon = await setupTest();

  daemon.port.startBrokerFailure();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({
    code: 'broker_not_ready',
    data: { detail: 'the broker CA did not install' },
  });

  await spawn.catch(() => null);

  const store = await StateStore.open(daemon.dbPath);
  const bindings = await store.collectAuthBindings();

  await store.stop();

  expect<Record<string, unknown>>({
    imps: daemon.port.collectImpNames(),
    bindings,
    listed: await daemon.client.sendRequest('session.list'),
  }).toStrictEqual({ imps: [], bindings: [], listed: { sessions: [] } });
});

test('it refuses a spawn with runtime auth on the local target before touching impd', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'local',
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await spawn.catch(() => null);

  expect(daemon.port.calls).toStrictEqual([]);
});

test('it starts an agent that takes the broker credential only where a broker is on the local target without touching impd', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'subscription',
    target: 'local',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const store = await StateStore.open(daemon.dbPath);
  const binding = await store.findAuthBinding(toSessionID(id));

  await store.stop();

  expect<Record<string, unknown>>({ calls: daemon.port.calls, binding }).toStrictEqual({
    calls: [],
    binding: null,
  });
});

test('it binds an agent that takes the broker credential only where a broker is on an imp target and starts it behind the broker', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'subscription',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;

  expect<Record<string, unknown>>({
    require: daemon.port.sessionRequests.map((request) =>
      request.kind === 'start' ? request.require : null,
    ),
    grants: await daemon.port.readGrants(imp),
  }).toStrictEqual({ require: [['broker']], grants: ['glm'] });
});

test.each([
  ['a spawn', false],
  ['a resume', 'a1'],
] as const)(
  'it refuses %s of a brokered agent with a workspace on the local target before materializing it',
  async (_kind, resume) => {
    await using daemon = await setupTest();

    const cwd = join(daemon.dir, 'ws');

    const spawn = daemon.client.sendRequest('session.spawn', {
      cwd,
      agent: 'glm',
      target: 'local',
      resume,
      workspace: { kind: 'path', path: join(daemon.dir, 'source') },
    });

    expect(spawn).rejects.toMatchObject({
      code: 'auth_target_unsupported',
      data: { agent: 'glm', target: 'local' },
    });

    await spawn.catch(() => null);

    expect<Record<string, unknown>>({
      calls: daemon.port.calls,
      created: await Bun.file(cwd).exists(),
      listed: await daemon.client.sendRequest('session.list'),
    }).toStrictEqual({ calls: [], created: false, listed: { sessions: [] } });
  },
);

test('it refuses to adopt a local session with a workspace once its agent takes the broker credential', async () => {
  await using daemon = await setupTest();

  daemon.setAuthSelected(false);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'local',
    resume: 'a1',
  });

  const id = toSessionID(String(getRecord(spawned, 'session')['id']));

  await daemon.client.sendRequest('session.kill', { session: id });

  const store = await StateStore.open(daemon.dbPath);

  await store.createMaterialization(
    { sessionID: id, target: 'local', dir: '/tmp', sourceKind: 'path', withheldEnv: [] },
    Date.now(),
  );

  await store.updateMaterialization(
    id,
    { phase: 'ready', repoURL: 'file:///src', sha: 'a'.repeat(40), ref: 'main', materializedAt: 1 },
    Date.now(),
  );

  const recorded = await store.findMaterialization(id);

  await store.stop();

  daemon.setAuthSelected(true);

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(adopt).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', target: 'local' },
  });

  await adopt.catch(() => null);

  const after = await StateStore.open(daemon.dbPath);
  const materialization = await after.findMaterialization(id);

  await after.stop();

  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect<Record<string, unknown>>({
    session: getRecord(got, 'session'),
    materialization,
    calls: daemon.port.calls,
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
  await using daemon = await setupTest();

  daemon.setAuthSelected(false);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'local',
    resume: 'a1',
  });

  const id = toSessionID(String(getRecord(spawned, 'session')['id']));

  const store = await StateStore.open(daemon.dbPath);

  await store.createMaterialization(
    { sessionID: id, target: 'local', dir: '/tmp', sourceKind: 'path', withheldEnv: [] },
    Date.now(),
  );

  await store.updateMaterialization(
    id,
    { phase: 'ready', repoURL: 'file:///src', sha: 'a'.repeat(40), ref: 'main', materializedAt: 1 },
    Date.now(),
  );

  const recorded = await store.findMaterialization(id);

  await store.stop();

  daemon.setAuthSelected(true);

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const after = await StateStore.open(daemon.dbPath);
  const materialization = await after.findMaterialization(id);

  await after.stop();

  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect<Record<string, unknown>>({
    session: getRecord(got, 'session'),
    materialization,
    calls: daemon.port.calls,
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
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.auth.revoke', { session: id });

  daemon.setAuthSelected(false);

  daemon.port.calls.length = 0;

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(adopt).rejects.toMatchObject({
    code: 'auth_rebind_required',
    data: { agent: 'glm', state: 'revoked' },
  });

  await adopt.catch(() => null);

  expect(daemon.port.calls).toStrictEqual([]);
});

test('it revives a session whose agent takes no broker credential on a host that holds no binding', async () => {
  await using daemon = await setupTest();

  daemon.setAuthSelected(false);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(
    daemon.port.sessionRequests.map((request) =>
      request.kind === 'start' ? (request.require ?? null) : request.kind,
    ),
  ).toStrictEqual([null, null]);
});

test('it restores a session whose agent dropped the broker credential while its host holds a binding without a terminal', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.auth.revoke', { session: id });

  daemon.setAuthSelected(false);

  await daemon.restart();

  const before = daemon.port.sessionRequests.length;

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect<Record<string, unknown>>({
    sent: daemon.port.sessionRequests.length - before,
    session: getRecord(got, 'session'),
  }).toStrictEqual({
    sent: 0,
    session: expect.objectContaining({ kind: 'headless', lastMsg: 'waiting to restore' }),
  });
});

test('it restores a session whose agent takes no broker credential on a host that holds no binding', async () => {
  await using daemon = await setupTest();

  daemon.setAuthSelected(false);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.restart();

  const before = daemon.port.sessionRequests.length;

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect<Record<string, unknown>>({
    sent: daemon.port.sessionRequests.length - before,
    session: getRecord(got, 'session'),
  }).toStrictEqual({ sent: 1, session: expect.objectContaining({ kind: 'pty' }) });
});

test('it refuses a revive that a revoke blocks while its host wakes, sending no start', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;

  await daemon.client.sendRequest('session.kill', { session: id });

  daemon.port.startLeaseHold();

  daemon.port.calls.length = 0;

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(daemon.port.calls.some((call) => call.startsWith(`leases.acquire ${imp} `))).toBeTrue();
  });

  daemon.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: id });

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  await revoke.catch(() => null);

  daemon.port.stopLeaseHold();

  expect(adopt).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { state: 'revocation_pending' },
  });

  await adopt.catch(() => null);

  await waitFor(() => {
    expect(daemon.port.findState(imp)).toBe('sleeping');
  });

  expect<Record<string, unknown>>({
    starts: daemon.port.sessionRequests.length,
    grants: await daemon.port.readGrants(imp),
  }).toStrictEqual({ starts: 1, grants: ['glm'] });
});

test('it refuses a sub-session spawn that a revoke blocks while it readies the shared host, sending no start', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = `atc-${parentID.replaceAll('-', '').slice(0, 20)}`;

  daemon.port.startLeaseHold();

  daemon.port.calls.length = 0;

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(daemon.port.calls.some((call) => call.startsWith(`leases.acquire ${imp} `))).toBeTrue();
  });

  daemon.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: parentID });

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  await revoke.catch(() => null);

  daemon.port.stopLeaseHold();

  expect(child).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { state: 'revocation_pending' },
  });

  await child.catch(() => null);

  expect(daemon.port.sessionRequests).toHaveLength(1);
});

test('it puts a shared host back to sleep when a revoke refuses the sub-session that woke it, keeping the imp and its grant', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = `atc-${parentID.replaceAll('-', '').slice(0, 20)}`;

  await daemon.client.sendRequest('session.kill', { session: parentID });

  await waitFor(() => {
    expect(daemon.port.findState(imp)).toBe('sleeping');
  });

  daemon.port.startLeaseHold();

  daemon.port.calls.length = 0;

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(daemon.port.calls.some((call) => call.startsWith(`leases.acquire ${imp} `))).toBeTrue();
  });

  daemon.port.setGrantRemovalFailure('UNREACHABLE');

  await daemon.client.sendRequest('session.auth.revoke', { session: parentID }).catch(() => null);

  daemon.port.stopLeaseHold();

  expect(child).rejects.toMatchObject({ code: 'auth_blocked' });

  await child.catch(() => null);

  await waitFor(() => {
    expect(daemon.port.findState(imp)).toBe('sleeping');
  });

  expect<Record<string, unknown>>({
    destroyed: daemon.port.calls.filter((call) => call.startsWith('imps.destroy')),
    grants: await daemon.port.readGrants(imp),
  }).toStrictEqual({ destroyed: [], grants: ['glm'] });
});

test('it keeps a shared host awake when a revoke refuses a sub-session while another harness runs there', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = `atc-${parentID.replaceAll('-', '').slice(0, 20)}`;

  daemon.port.startLeaseHold();

  daemon.port.calls.length = 0;

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(daemon.port.calls.some((call) => call.startsWith(`leases.acquire ${imp} `))).toBeTrue();
  });

  daemon.port.setGrantRemovalFailure('UNREACHABLE');

  await daemon.client.sendRequest('session.auth.revoke', { session: parentID }).catch(() => null);

  daemon.port.stopLeaseHold();

  expect(child).rejects.toMatchObject({ code: 'auth_blocked' });

  await child.catch(() => null);

  expect<Record<string, unknown>>({
    state: daemon.port.findState(imp),
    sleeps: daemon.port.calls.filter((call) => call.startsWith('imps.sleep')),
  }).toStrictEqual({ state: 'running', sleeps: [] });
});

test('it keeps a host awake for a sub-session that readies it while a refused revive puts it to sleep', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = `atc-${parentID.replaceAll('-', '').slice(0, 20)}`;

  await daemon.client.sendRequest('session.kill', { session: parentID });

  daemon.port.startBrokerFailure();
  daemon.port.startReleaseHold();

  daemon.port.calls.length = 0;

  const revive = daemon.client.sendRequest('session.adopt', {
    session: parentID,
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(daemon.port.calls.filter((call) => call.startsWith('leases.release'))).toHaveLength(1);
  });

  daemon.port.stopBrokerFailure();

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(daemon.port.calls.filter((call) => call.startsWith(`grants.list ${imp}`))).toHaveLength(
      2,
    );
  });

  daemon.port.stopReleaseHold();

  expect(revive).rejects.toMatchObject({ code: 'broker_not_ready' });

  await revive.catch(() => null);

  const spawnedChild = await child;

  const childID = String(getRecord(spawnedChild, 'session')['id']);

  const got = await daemon.client.sendRequest('session.get', { session: childID });

  expect<Record<string, unknown>>({
    sleeps: daemon.port.calls.filter((call) => call.startsWith('imps.sleep')),
    state: daemon.port.findState(imp),
    child: getRecord(got, 'session'),
  }).toStrictEqual({
    sleeps: [],
    state: 'running',
    child: expect.objectContaining({ kind: 'pty', alive: true }),
  });
});

test('it puts a host to sleep after a refused revive when no other launch readies it', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = `atc-${parentID.replaceAll('-', '').slice(0, 20)}`;

  await daemon.client.sendRequest('session.kill', { session: parentID });

  daemon.port.startBrokerFailure();
  daemon.port.startReleaseHold();

  daemon.port.calls.length = 0;

  const revive = daemon.client.sendRequest('session.adopt', {
    session: parentID,
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(daemon.port.calls.filter((call) => call.startsWith('leases.release'))).toHaveLength(1);
  });

  daemon.port.stopReleaseHold();

  expect(revive).rejects.toMatchObject({ code: 'broker_not_ready' });

  await revive.catch(() => null);

  await waitFor(() => {
    expect(daemon.port.findState(imp)).toBe('sleeping');
  });

  expect(daemon.port.calls.filter((call) => call.startsWith('imps.sleep'))).toHaveLength(1);
});

test('it spawns a sub-session on the shared host while it readies when no revoke comes between', async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = `atc-${parentID.replaceAll('-', '').slice(0, 20)}`;

  daemon.port.startLeaseHold();

  daemon.port.calls.length = 0;

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(daemon.port.calls.some((call) => call.startsWith(`leases.acquire ${imp} `))).toBeTrue();
  });

  daemon.port.stopLeaseHold();

  await child;

  expect(daemon.port.sessionRequests).toHaveLength(2);
});

test('it sends no start for a revive that a revoke blocks while its connection to impd opens', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;

  await daemon.client.sendRequest('session.kill', { session: id });

  daemon.port.startUpgradeHold();

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(daemon.port.countHeldUpgrades()).toBe(1);
  });

  daemon.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: id });

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  await revoke.catch(() => null);

  daemon.port.stopUpgradeHold();

  expect(adopt).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { state: 'revocation_pending' },
  });

  await adopt.catch(() => null);

  expect<Record<string, unknown>>({
    starts: daemon.port.sessionRequests.length,
    grants: await daemon.port.readGrants(imp),
  }).toStrictEqual({ starts: 1, grants: ['glm'] });
});

test('it sends the start of a revive whose connection to impd opens late when no revoke comes between', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });

  daemon.port.startUpgradeHold();

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(daemon.port.countHeldUpgrades()).toBe(1);
  });

  daemon.port.stopUpgradeHold();

  await adopt;

  expect(daemon.port.sessionRequests).toHaveLength(2);
});

test('it revives a session while its host wakes when no revoke comes between', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;

  await daemon.client.sendRequest('session.kill', { session: id });

  daemon.port.startLeaseHold();

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(daemon.port.calls.some((call) => call.startsWith(`leases.acquire ${imp} `))).toBeTrue();
  });

  daemon.port.stopLeaseHold();

  await adopt;

  expect(daemon.port.sessionRequests).toHaveLength(2);
});

test('it revives a slept session after verifying its binding, granting nothing again', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;

  await daemon.client.sendRequest('session.kill', { session: id });

  daemon.port.calls.length = 0;

  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect<Record<string, unknown>>({
    calls: daemon.port.calls.filter((call) => !call.startsWith('leases.renew')),
    require: daemon.port.sessionRequests.map((request) =>
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
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.port.removeGrant(imp, 'glm');

  daemon.port.calls.length = 0;

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(adopt).rejects.toMatchObject({ code: 'auth_grant_missing' });

  await adopt.catch(() => null);

  expect<Record<string, unknown>>({
    starts: daemon.port.sessionRequests.length,
    granted: daemon.port.calls.filter((call) => call.startsWith('grants.add')),
    state: daemon.port.findState(imp),
  }).toStrictEqual({ starts: 1, granted: [], state: 'sleeping' });
});

test('it refuses to revive a session whose broker is not ready and puts its host back to sleep', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;

  await daemon.client.sendRequest('session.kill', { session: id });

  daemon.port.startBrokerFailure();

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(adopt).rejects.toMatchObject({ code: 'broker_not_ready' });

  await adopt.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect<Record<string, unknown>>({ state: daemon.port.findState(imp), listed }).toMatchObject({
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
  await using daemon = await setupTest();

  const spawned = await Promise.all([
    daemon.client.sendRequest('session.spawn', { cwd: '/tmp', agent: 'glm', target: 'box' }),
    daemon.client.sendRequest('session.spawn', { cwd: '/tmp', agent: 'glm', target: 'box' }),
  ]);

  const imps = spawned.map(
    (answer) =>
      `atc-${String(getRecord(answer, 'session')['id']).replaceAll('-', '').slice(0, 20)}`,
  );

  const grants = await Promise.all(imps.map((imp) => daemon.port.readGrants(imp)));
  const store = await StateStore.open(daemon.dbPath);
  const bindings = await store.collectAuthBindings();

  await store.stop();

  expect<Record<string, unknown>>({
    imps: daemon.port.collectImpNames().toSorted(),
    grants,
    states: bindings.map((binding) => binding.state),
  }).toStrictEqual({
    imps: imps.toSorted(),
    grants: [['glm'], ['glm']],
    states: ['ready', 'ready'],
  });
});

test('it revokes the grants of a running session while its harness keeps running', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;

  const revoked = await daemon.client.sendRequest('session.auth.revoke', { session: id });
  const listed = await daemon.client.sendRequest('session.list');

  expect<Record<string, unknown>>({
    revoked,
    grants: await daemon.port.readGrants(imp),
    listed,
  }).toStrictEqual({
    revoked: { revoked: true },
    grants: [],
    listed: { sessions: [expect.objectContaining({ id, alive: true })] },
  });
});

test('it refuses to revive a session revoked while it slept', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.auth.revoke', { session: id });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(adopt).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });

  await adopt.catch(() => null);

  expect(daemon.port.sessionRequests).toHaveLength(1);
});

test('it rebinds a revoked session so it revives under the next revision', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.auth.revoke', { session: id });

  const rebound = await daemon.client.sendRequest('session.auth.rebind', { session: id });

  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect<Record<string, unknown>>({
    rebound,
    argv: daemon.port.sessionRequests.map((request) =>
      request.kind === 'start' ? request.argv.at(-1) : null,
    ),
  }).toStrictEqual({
    rebound: { revision: 2 },
    argv: ['echo "revision 1"; exec sleep 30', 'echo "revision 2"; exec sleep 30'],
  });
});

test('it refuses session.auth.revoke from a principal as unauthorized and revokes nothing', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = `atc-${id.replaceAll('-', '').slice(0, 20)}`;
  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: id }, 'ops');

  expect(revoke).rejects.toMatchObject({ code: 'unauthorized' });

  await revoke.catch(() => null);

  const grants = await daemon.port.readGrants(imp);

  expect(grants).toStrictEqual(['glm']);
});

test('it refuses session.auth.rebind from a principal as unauthorized and binds nothing', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  daemon.port.calls.length = 0;

  const rebind = daemon.client.sendRequest('session.auth.rebind', { session: id }, 'ops');

  expect(rebind).rejects.toMatchObject({ code: 'unauthorized' });

  await rebind.catch(() => null);

  expect(daemon.port.calls.filter((call) => !call.startsWith('leases.renew'))).toStrictEqual([]);
});

test('it forgets a bound session by destroying its imp and dropping its binding, never a secret', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const offered = await daemon.client.sendRequest('session.forget', { session: id });

  await daemon.client.sendRequest('session.forget', {
    session: id,
    confirmToken: offered['confirmToken'],
  });

  const store = await StateStore.open(daemon.dbPath);
  const bindings = await store.collectAuthBindings();

  await store.stop();

  const secrets = await daemon.port.readSecrets();

  expect<Record<string, unknown>>({
    imps: daemon.port.collectImpNames(),
    secrets: secrets.map((secret) => secret.name),
    bindings,
  }).toStrictEqual({ imps: [], secrets: ['glm'], bindings: [] });
});

test("it runs a sub-session under the same binding in its parent's imp without granting again", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  daemon.port.calls.length = 0;

  await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  expect<Record<string, unknown>>({
    imps: daemon.port.collectImpNames(),
    created: daemon.port.calls.filter(
      (call) => call.startsWith('imps.create') || call.startsWith('grants.add'),
    ),
    require: daemon.port.sessionRequests.map((request) =>
      request.kind === 'start' ? request.require : null,
    ),
  }).toStrictEqual({
    imps: [expect.any(String)],
    created: [],
    require: [['broker'], ['broker']],
  });
});

test("it refuses a sub-session without runtime auth in a bound parent's imp", async () => {
  await using daemon = await setupTest();

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'plain',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_binding_mismatch' });

  await spawn.catch(() => null);

  expect(daemon.port.sessionRequests).toHaveLength(1);
});

test('it takes back, as it starts, a spawn a stopped daemon left provisioning', async () => {
  await using daemon = await setupTest();

  const store = await StateStore.open(daemon.dbPath);

  await new RuntimeAuthBinder(store).createBinding(daemon.provider.brokerAuth, {
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

  await store.stop();

  daemon.port.calls.length = 0;

  await daemon.restart();

  await waitFor(() => {
    expect(daemon.port.collectImpNames()).toStrictEqual([]);
  });

  expect(daemon.port.calls).toStrictEqual([
    'tokens.whoami',
    'imps.get atc-orphan',
    'imps.destroy atc-orphan',
    'imps.get atc-orphan',
  ]);
});

test('it restores a session whose broker is not ready without a terminal', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.restart();

  daemon.port.startBrokerFailure();

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id, alive: false })],
  });
});
