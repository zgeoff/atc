import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubBrokeredAgentAdapter } from '../test-utils/build-stub-brokered-agent-adapter';
import { buildStubProxiedAgentAdapter } from '../test-utils/build-stub-proxied-agent-adapter';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { getOnlyImpName } from '../test-utils/get-only-imp-name';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';
import { RuntimeAuthBinder } from './runtime-auth-binder';

/**
 * A stub imp port whose impd holds nothing until the test adds it, and
 * the imp provider over it, which each test hands to the daemon it starts
 * as the target `box`.
 */
function setupTest() {
  const tmp = setupTempDir('atc-runtime-auth-');
  const port = createStubImpPort();

  const provider = new ImpProvider(port, { guestDir: join(tmp.dir, 'g') }, { atcBinary: null });

  registerTestCleanup(() => {
    provider.dispose();
  });

  return { dir: tmp.dir, port, provider };
}

test('it provisions the host of a spawn before readying it and starts the harness only behind a ready broker', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  const binding = await store.findAuthBinding(toSessionID(id));

  const calls = ctx.port.calls.filter((call) => !call.startsWith('leases.renew'));

  const grants = await ctx.port.readGrants(imp);

  expect(calls).toStrictEqual([
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
  ]);

  expect(ctx.port.sessionRequests.map((request) => [request.kind, request.require])).toStrictEqual([
    ['start', ['broker']],
  ]);

  expect(grants).toStrictEqual(['glm']);
  expect(binding).toMatchObject({ state: 'ready', revision: 1, impName: imp });
});

test('it lists the imp target as reaching the broker and the local target as reaching none', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const listed = await daemon.client.sendRequest('agents.list');

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
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [
        glm,
        buildMockAgentAdapter({ id: 'plain' }),
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
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const listed = await daemon.client.sendRequest('agents.list');

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
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const [start] = ctx.port.sessionRequests;

  invariant(start?.kind === 'start', 'expected the harness start');

  expect(start.env).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
    CLAUDE_CONFIG_DIR: expect.toEndWith(`/sessions/${id}/claude-config`),
    ATC_SESSION_ID: id,
  });
});

test('it refuses a brokered spawn whose guest plan sets a proxy variable before touching impd', async () => {
  const ctx = setupTest();

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const proxied = buildStubProxiedAgentAdapter({ id: 'proxied' });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm, proxied],
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
      defaultTarget: 'box',
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'proxied',
    target: 'box',
  });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { problem: 'guest_env_conflict', variable: 'https_proxy' },
  });

  expect(ctx.port.calls).toStrictEqual([]);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a spawn on an impd without exec requirements after reading only its features', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  ctx.port.features = { ...ctx.port.features, execRequire: false };

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({ code: 'auth_impd_too_old' });
  expect(ctx.port.calls).toStrictEqual(['system.info']);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a spawn whose broker is not ready, takes back its imp, and lists no session', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  ctx.port.startBrokerFailure();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  await spawn.catch(() => null);

  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  const bindings = await store.collectAuthBindings();
  const listed = await daemon.client.sendRequest('session.list');

  // The imp the spawn created and then destroyed, in call order.
  const lifecycle = ctx.port.calls.filter(
    (call) => call.startsWith('imps.create ') || call.startsWith('imps.destroy '),
  );

  const [created] = lifecycle;

  invariant(created !== undefined, 'the spawn created no imp');

  const imp = created.slice('imps.create '.length);

  expect(spawn).rejects.toMatchObject({
    code: 'broker_not_ready',
    data: { detail: 'the broker CA did not install' },
  });

  expect(lifecycle).toStrictEqual([`imps.create ${imp}`, `imps.destroy ${imp}`]);
  expect(ctx.port.collectImpNames()).toStrictEqual([]);
  expect(bindings).toStrictEqual([]);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a spawn with runtime auth on the local target before touching impd', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it starts an agent that takes the broker credential only where a broker is on the local target without touching impd', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [
        glm,
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
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'subscription',
    target: 'local',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  const binding = await store.findAuthBinding(toSessionID(id));

  expect(ctx.port.calls).toStrictEqual([]);
  expect(binding).toBeNull();
});

test('it binds an agent that takes the broker credential only where a broker is on an imp target and starts it behind the broker', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [
        glm,
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
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.provider },
      ],
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'subscription',
    target: 'box',
  });

  const imp = getOnlyImpName(ctx.port);

  const grants = await ctx.port.readGrants(imp);

  expect(ctx.port.sessionRequests.map((request) => [request.kind, request.require])).toStrictEqual([
    ['start', ['broker']],
  ]);

  expect(grants).toStrictEqual(['glm']);
});

test.each([
  ['a spawn', false],
  ['a resume', 'a1'],
] as const)(
  'it refuses %s of a brokered agent with a workspace on the local target before materializing it',
  async (_kind, resume) => {
    const ctx = setupTest();

    const glm = buildStubBrokeredAgentAdapter({
      id: 'glm',
      brokerRequired: true,
      isSelected: () => true,
    });

    const daemon = await startTestDaemon({
      prefix: 'atc-runtime-auth-daemon-',
      options: () => ({
        adapter: glm,
        adapters: [glm],
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
        defaultTarget: 'box',
      }),
    });

    // The token may grant glm, and impd holds glm for api.z.ai.
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

    const cwd = join(ctx.dir, 'ws');

    const spawn = daemon.client.sendRequest('session.spawn', {
      cwd,
      agent: 'glm',
      target: 'local',
      resume,
      workspace: { kind: 'path', path: join(ctx.dir, 'source') },
    });

    await spawn.catch(() => null);

    const listed = await daemon.client.sendRequest('session.list');

    expect(spawn).rejects.toMatchObject({
      code: 'auth_target_unsupported',
      data: { agent: 'glm', target: 'local' },
    });

    expect(ctx.port.calls).toStrictEqual([]);
    expect(existsSync(cwd)).toBe(false);
    expect(listed).toStrictEqual({ sessions: [] });
  },
);

test('it refuses to adopt a local session with a workspace once its agent takes the broker credential', async () => {
  const ctx = setupTest();

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  let authSelected = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => authSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  authSelected = false;

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
    resume: 'a1',
  });

  const id = toSessionID(String(getRecord(spawned, 'session')['id']));

  await daemon.client.sendRequest('session.kill', { session: id });

  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

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

  const recorded = await store.findMaterialization(id);

  authSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  const materialization = await store.findMaterialization(id);
  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect(adopt).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', target: 'local' },
  });

  expect(getRecord(got, 'session')).toContainEntries([
    ['state', 'exited'],
    ['alive', false],
    ['workspace', { repoURL: 'file:///src', sha: 'a'.repeat(40), ref: 'main', materializedAt: 1 }],
  ]);

  expect(materialization).toStrictEqual(recorded);
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it restores a local session with a workspace without a terminal once its agent takes the broker credential', async () => {
  const ctx = setupTest();

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  let authSelected = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => authSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  authSelected = false;

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'local',
    resume: 'a1',
  });

  const id = toSessionID(String(getRecord(spawned, 'session')['id']));

  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

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

  const recorded = await store.findMaterialization(id);

  authSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const materialization = await store.findMaterialization(id);
  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect(getRecord(got, 'session')).toContainEntries([
    ['kind', 'headless'],
    ['lastMsg', 'waiting to restore'],
    ['workspace', { repoURL: 'file:///src', sha: 'a'.repeat(40), ref: 'main', materializedAt: 1 }],
  ]);

  expect(materialization).toStrictEqual(recorded);
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it refuses to revive a session whose agent dropped the broker credential while its host holds a binding', async () => {
  const ctx = setupTest();

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  let authSelected = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => authSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.auth.revoke', { session: id });

  authSelected = false;
  ctx.port.calls.length = 0;

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  expect(adopt).rejects.toMatchObject({
    code: 'auth_rebind_required',
    data: { agent: 'glm', state: 'revoked' },
  });

  expect(ctx.port.calls).toStrictEqual([]);
});

test('it revives a session whose agent takes no broker credential on a host that holds no binding', async () => {
  const ctx = setupTest();

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  let authSelected = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => authSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  authSelected = false;

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(ctx.port.sessionRequests.map((request) => [request.kind, request.require])).toStrictEqual([
    ['start', undefined],
    ['start', undefined],
  ]);
});

test('it restores a session whose agent dropped the broker credential while its host holds a binding without a terminal', async () => {
  const ctx = setupTest();

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  let authSelected = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => authSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.auth.revoke', { session: id });

  authSelected = false;

  await daemon.restart();

  const before = ctx.port.sessionRequests.length;

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect(ctx.port.sessionRequests.length - before).toBe(0);

  expect(getRecord(got, 'session')).toMatchObject({
    kind: 'headless',
    lastMsg: 'waiting to restore',
  });
});

test('it restores a session whose agent takes no broker credential on a host that holds no binding', async () => {
  const ctx = setupTest();

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  let authSelected = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => authSelected,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  authSelected = false;

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.restart();

  const before = ctx.port.sessionRequests.length;

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect(ctx.port.sessionRequests.length - before).toBe(1);
  expect(getRecord(got, 'session')).toMatchObject({ kind: 'pty' });
});

test('it refuses a revive that a revoke blocks while its host wakes, sending no start', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: id });

  ctx.port.startLeaseHold();

  // A held lease acquisition would keep the daemon's stop waiting.
  const stopLeaseHold = registerTestCleanup(() => {
    ctx.port.stopLeaseHold();
  });

  ctx.port.calls.length = 0;

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: id });

  await revoke.catch(() => null);

  stopLeaseHold();

  await adopt.catch(() => null);

  await waitFor(() => {
    expect(ctx.port.findState(imp)).toBe('sleeping');
  });

  const grants = await ctx.port.readGrants(imp);

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  expect(adopt).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { state: 'revocation_pending' },
  });

  expect(ctx.port.sessionRequests.length).toBe(1);
  expect(grants).toStrictEqual(['glm']);
});

test('it refuses a sub-session spawn that a revoke blocks while it readies the shared host, sending no start', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  ctx.port.startLeaseHold();

  // A held lease acquisition would keep the daemon's stop waiting.
  const stopLeaseHold = registerTestCleanup(() => {
    ctx.port.stopLeaseHold();
  });

  ctx.port.calls.length = 0;

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: parentID });

  await revoke.catch(() => null);

  stopLeaseHold();

  await child.catch(() => null);

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  expect(child).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { state: 'revocation_pending' },
  });

  expect(ctx.port.sessionRequests).toHaveLength(1);
});

test('it puts a shared host back to sleep when a revoke refuses the sub-session that woke it, keeping the imp and its grant', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: parentID });

  await waitFor(() => {
    expect(ctx.port.findState(imp)).toBe('sleeping');
  });

  ctx.port.startLeaseHold();

  // A held lease acquisition would keep the daemon's stop waiting.
  const stopLeaseHold = registerTestCleanup(() => {
    ctx.port.stopLeaseHold();
  });

  ctx.port.calls.length = 0;

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: parentID });

  await revoke.catch(() => null);

  stopLeaseHold();

  await child.catch(() => null);

  await waitFor(() => {
    expect(ctx.port.findState(imp)).toBe('sleeping');
  });

  const grants = await ctx.port.readGrants(imp);

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });
  expect(child).rejects.toMatchObject({ code: 'auth_blocked' });
  expect(ctx.port.calls.filter((call) => call.startsWith('imps.destroy'))).toStrictEqual([]);
  expect(grants).toStrictEqual(['glm']);
});

test('it keeps a shared host awake when a revoke refuses a sub-session while another harness runs there', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  ctx.port.startLeaseHold();

  // A held lease acquisition would keep the daemon's stop waiting.
  const stopLeaseHold = registerTestCleanup(() => {
    ctx.port.stopLeaseHold();
  });

  ctx.port.calls.length = 0;

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: parentID });

  await revoke.catch(() => null);

  stopLeaseHold();

  await child.catch(() => null);

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });
  expect(child).rejects.toMatchObject({ code: 'auth_blocked' });
  expect(ctx.port.findState(imp)).toBe('running');
  expect(ctx.port.calls.filter((call) => call.startsWith('imps.sleep'))).toStrictEqual([]);
});

test('it keeps a host awake for a sub-session that readies it while a refused revive puts it to sleep', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: parentID });

  ctx.port.startBrokerFailure();
  ctx.port.startReleaseHold();

  // A held lease release would keep the daemon's stop waiting.
  const stopReleaseHold = registerTestCleanup(() => {
    ctx.port.stopReleaseHold();
  });

  ctx.port.calls.length = 0;

  const revive = daemon.client.sendRequest('session.adopt', {
    session: parentID,
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.startsWith('leases.release'))).toHaveLength(1);
  });

  ctx.port.stopBrokerFailure();

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.startsWith(`grants.list ${imp}`))).toHaveLength(2);
  });

  stopReleaseHold();

  await revive.catch(() => null);

  const spawnedChild = await child;

  const childID = String(getRecord(spawnedChild, 'session')['id']);

  const got = await daemon.client.sendRequest('session.get', { session: childID });

  expect(revive).rejects.toMatchObject({ code: 'broker_not_ready' });
  expect(ctx.port.calls.filter((call) => call.startsWith('imps.sleep'))).toStrictEqual([]);
  expect(ctx.port.findState(imp)).toBe('running');
  expect(getRecord(got, 'session')).toMatchObject({ kind: 'pty', alive: true });
});

test('it puts a host to sleep after a refused revive when no other launch readies it', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: parentID });

  ctx.port.startBrokerFailure();
  ctx.port.startReleaseHold();

  // A held lease release would keep the daemon's stop waiting.
  const stopReleaseHold = registerTestCleanup(() => {
    ctx.port.stopReleaseHold();
  });

  ctx.port.calls.length = 0;

  const revive = daemon.client.sendRequest('session.adopt', {
    session: parentID,
    cols: 80,
    rows: 24,
  });

  await waitFor(() => {
    expect(ctx.port.calls.filter((call) => call.startsWith('leases.release'))).toHaveLength(1);
  });

  stopReleaseHold();

  await revive.catch(() => null);

  await waitFor(() => {
    expect(ctx.port.findState(imp)).toBe('sleeping');
  });

  expect(revive).rejects.toMatchObject({ code: 'broker_not_ready' });
  expect(ctx.port.calls.filter((call) => call.startsWith('imps.sleep'))).toHaveLength(1);
});

test('it spawns a sub-session on the shared host while it readies when no revoke comes between', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  ctx.port.startLeaseHold();

  // A held lease acquisition would keep the daemon's stop waiting.
  const stopLeaseHold = registerTestCleanup(() => {
    ctx.port.stopLeaseHold();
  });

  ctx.port.calls.length = 0;

  const child = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: parentID,
  });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  stopLeaseHold();

  await child;

  expect(ctx.port.sessionRequests).toHaveLength(2);
});

test('it sends no start for a revive that a revoke blocks while its connection to impd opens', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: id });

  ctx.port.startUpgradeHold();

  // A held connection upgrade would keep the daemon's stop waiting.
  const stopUpgradeHold = registerTestCleanup(() => {
    ctx.port.stopUpgradeHold();
  });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.countHeldUpgrades()).toBe(1);
  });

  ctx.port.setGrantRemovalFailure('UNREACHABLE');

  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: id });

  await revoke.catch(() => null);

  stopUpgradeHold();

  await adopt.catch(() => null);

  const grants = await ctx.port.readGrants(imp);

  expect(revoke).rejects.toMatchObject({ code: 'auth_revocation_pending' });

  expect(adopt).rejects.toMatchObject({
    code: 'auth_blocked',
    data: { state: 'revocation_pending' },
  });

  expect(ctx.port.sessionRequests.length).toBe(1);
  expect(grants).toStrictEqual(['glm']);
});

test('it sends the start of a revive whose connection to impd opens late when no revoke comes between', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });

  ctx.port.startUpgradeHold();

  // A held connection upgrade would keep the daemon's stop waiting.
  const stopUpgradeHold = registerTestCleanup(() => {
    ctx.port.stopUpgradeHold();
  });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.countHeldUpgrades()).toBe(1);
  });

  stopUpgradeHold();

  await adopt;

  expect(ctx.port.sessionRequests).toHaveLength(2);
});

test('it revives a session while its host wakes when no revoke comes between', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: id });

  ctx.port.startLeaseHold();

  // A held lease acquisition would keep the daemon's stop waiting.
  const stopLeaseHold = registerTestCleanup(() => {
    ctx.port.stopLeaseHold();
  });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.calls).toContainEqual(expect.toStartWith(`leases.acquire ${imp} `));
  });

  stopLeaseHold();

  await adopt;

  expect(ctx.port.sessionRequests).toHaveLength(2);
});

test('it revives a slept session after verifying its binding, granting nothing again', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: id });

  ctx.port.calls.length = 0;

  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(ctx.port.calls.filter((call) => !call.startsWith('leases.renew'))).toStrictEqual([
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
  ]);

  expect(ctx.port.sessionRequests.map((request) => [request.kind, request.require])).toStrictEqual([
    ['start', ['broker']],
    ['start', ['broker']],
  ]);
});

test('it refuses to revive a session whose grant was revoked outside atc and grants it no more', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: id });
  await ctx.port.removeGrant(imp, 'glm');

  ctx.port.calls.length = 0;

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  expect(adopt).rejects.toMatchObject({ code: 'auth_grant_missing' });
  expect(ctx.port.sessionRequests.length).toBe(1);
  expect(ctx.port.calls.filter((call) => call.startsWith('grants.add'))).toStrictEqual([]);
  expect(ctx.port.findState(imp)).toBe('sleeping');
});

test('it refuses to revive a session whose broker is not ready and puts its host back to sleep', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  await daemon.client.sendRequest('session.kill', { session: id });

  ctx.port.startBrokerFailure();

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(adopt).rejects.toMatchObject({ code: 'broker_not_ready' });
  expect(ctx.port.findState(imp)).toBe('sleeping');

  expect(listed).toMatchObject({
    sessions: [
      {
        id,
        alive: false,
        lastMsg: 'imp broker not ready (the broker CA did not install)',
        lifecycle: { vm: 'asleep' },
      },
    ],
  });
});

test('it provisions concurrent spawns each in an imp of its own with only its own grant', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await Promise.all([
    daemon.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'glm', target: 'box' }),
    daemon.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'glm', target: 'box' }),
  ]);

  const imps = ctx.port.collectImpNames();

  const grants = await Promise.all(imps.map((imp) => ctx.port.readGrants(imp)));
  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  const bindings = await store.collectAuthBindings();

  expect<readonly unknown[]>(imps).toStrictEqual([
    expect.stringMatching(/^atc-[\da-f]{20}$/),
    expect.stringMatching(/^atc-[\da-f]{20}$/),
  ]);

  expect(grants).toStrictEqual([['glm'], ['glm']]);

  expect(bindings.map((binding) => binding.hostKey)).toIncludeSameMembers(
    spawned.map((answer) => getRecord(answer, 'session')['id']),
  );

  expect(bindings.map((binding) => binding.impName)).toIncludeSameMembers(imps);
  expect(bindings.map((binding) => binding.state)).toStrictEqual(['ready', 'ready']);
});

test('it revokes the grants of a running session while its harness keeps running', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  const revoked = await daemon.client.sendRequest('session.auth.revoke', { session: id });
  const listed = await daemon.client.sendRequest('session.list');
  const grants = await ctx.port.readGrants(imp);

  expect(revoked).toStrictEqual({ revoked: true });
  expect(grants).toStrictEqual([]);
  expect(listed).toStrictEqual({ sessions: [expect.objectContaining({ id, alive: true })] });
});

test('it refuses to revive a session revoked while it slept', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.auth.revoke', { session: id });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await adopt.catch(() => null);

  expect(adopt).rejects.toMatchObject({ code: 'auth_blocked', data: { state: 'revoked' } });
  expect(ctx.port.sessionRequests).toHaveLength(1);
});

test('it rebinds a revoked session so it revives under the next revision', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.auth.revoke', { session: id });

  const rebound = await daemon.client.sendRequest('session.auth.rebind', { session: id });

  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(rebound).toStrictEqual({ revision: 2 });

  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([
    expect.objectContaining({
      kind: 'start',
      argv: ['sh', '-c', 'echo "revision 1"; exec sleep 30'],
    }),
    expect.objectContaining({
      kind: 'start',
      argv: ['sh', '-c', 'echo "revision 2"; exec sleep 30'],
    }),
  ]);
});

test('it refuses session.auth.revoke from a principal as unauthorized and revokes nothing', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',

      // The principal tests open a client as ops.
      principals: new Map([['ops', ['box']]]),
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);
  const revoke = daemon.client.sendRequest('session.auth.revoke', { session: id }, 'ops');

  await revoke.catch(() => null);

  const grants = await ctx.port.readGrants(imp);

  expect(revoke).rejects.toMatchObject({ code: 'unauthorized' });
  expect(grants).toStrictEqual(['glm']);
});

test('it refuses session.auth.rebind from a principal as unauthorized and binds nothing', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',

      // The principal tests open a client as ops.
      principals: new Map([['ops', ['box']]]),
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  ctx.port.calls.length = 0;

  const rebind = daemon.client.sendRequest('session.auth.rebind', { session: id }, 'ops');

  await rebind.catch(() => null);

  expect(rebind).rejects.toMatchObject({ code: 'unauthorized' });
  expect(ctx.port.calls.filter((call) => !call.startsWith('leases.renew'))).toStrictEqual([]);
});

test('it forgets a bound session by destroying its imp and dropping its binding, never a secret', async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',

      // A forget waits this long for its confirmation.
      forgetConfirmMs: 60_000,
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
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

  registerTestCleanup(() => store.stop());

  const bindings = await store.collectAuthBindings();
  const secrets = await ctx.port.readSecrets();

  expect(ctx.port.collectImpNames()).toStrictEqual([]);
  expect(secrets.map((secret) => secret.name)).toStrictEqual(['glm']);
  expect(bindings).toStrictEqual([]);
});

test("it runs a sub-session under the same binding in its parent's imp without granting again", async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  ctx.port.calls.length = 0;

  await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    parent: getRecord(parent, 'session')['id'],
  });

  expect<readonly unknown[]>(ctx.port.collectImpNames()).toStrictEqual([expect.any(String)]);

  expect(
    ctx.port.calls.filter(
      (call) => call.startsWith('imps.create') || call.startsWith('grants.add'),
    ),
  ).toStrictEqual([]);

  expect(ctx.port.sessionRequests.map((request) => [request.kind, request.require])).toStrictEqual([
    ['start', ['broker']],
    ['start', ['broker']],
  ]);
});

test("it refuses a sub-session without runtime auth in a bound parent's imp", async () => {
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm, buildMockAgentAdapter({ id: 'plain' })],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
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
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

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

  ctx.port.calls.length = 0;

  await daemon.restart();

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
  const ctx = setupTest();

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm],
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
      defaultTarget: 'box',
    }),
  });

  // The token may grant glm, and impd holds glm for api.z.ai.
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.restart();

  ctx.port.startBrokerFailure();

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id, alive: false, kind: 'headless' })],
  });
});
