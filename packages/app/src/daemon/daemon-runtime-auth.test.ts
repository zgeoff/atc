import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock, toSessionID } from '@atc/core';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort, getOnlyImpName } from '@atc/execution-imp/testing';
import { LocalPTYProvider } from '@atc/execution-local';
import { verifyRestoredFleet } from '@atc/lifecycle';
import { StateStore } from '@atc/store';
import {
  buildMockAgentAdapter,
  buildStubBrokeredAgentAdapter,
  buildStubProxiedAgentAdapter,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { RuntimeAuthBinder } from './runtime-auth-binder';

interface SetupConfig {
  readonly rebindChangedAuth: boolean;
}

/**
 * A stub imp port whose impd holds nothing until the test adds it, and
 * the imp provider over it, which each test hands to the daemon it starts
 * as the target `box`; the config chooses whether that target rebinds a
 * changed auth selection.
 */
function setupTest(config?: SetupConfig) {
  const tmp = setupTempDir('atc-runtime-auth-');
  const port = createStubImpPort();

  const provider = new ImpProvider(
    port,
    { guestDir: join(tmp.dir, 'g'), rebindChangedAuth: config?.rebindChangedAuth ?? false },
    { atcBinary: null, version: '1.0.0' },
  );

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
    expect.toInclude('mkdir -p "$1/run" && { [ -z "$2" ] || [ -x "$2" ]; }'),
    expect.toStartWith(`exec.run ${imp} sh -c umask 022 && mkdir -p "$1" && printf`),
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
    [
      'lastMsg',
      "agent 'glm' takes its credential from impd's broker, which target 'local' does not reach",
    ],
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
    lastMsg: `agent 'glm' takes no credential from impd's broker, but its host holds a runtime auth binding; give the agent its auth block back, or forget the session. Once the auth block is back: atc session adopt ${id} (MCP: atc_session_adopt)`,
    restoreRefusal: 'auth_rebind_required',
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
    expect.toInclude('mkdir -p "$1/run" && { [ -z "$2" ] || [ -x "$2" ]; }'),
    expect.toStartWith(`exec.run ${imp} sh -c umask 022 && mkdir -p "$1" && printf`),
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

  expect(rebound).toStrictEqual({ revision: 2, restartPending: [id] });

  // The adopt attaches the harness the imp kept asleep, ends it, and starts
  // a fresh one under the new revision.
  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([
    expect.objectContaining({
      kind: 'start',
      argv: ['sh', '-c', 'echo "revision 1"; exec sleep 30'],
    }),
    expect.objectContaining({
      kind: 'start',
      argv: ['sh', '-c', 'echo "revision 2"; exec sleep 30'],
    }),
    expect.objectContaining({
      kind: 'start',
      argv: ['sh', '-c', 'echo "revision 2"; exec sleep 30'],
    }),
  ]);
});

test('it restarts a suspended harness under the new revision when a rebind comes before its adopt', async () => {
  const ctx = setupTest();
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  // The kill puts the imp to sleep with the harness kept inside it.
  await daemon.client.sendRequest('session.kill', { session: id });

  judgeSelected = true;

  const rebound = await daemon.client.sendRequest('session.auth.rebind', { session: id });
  const pending = await daemon.client.sendRequest('session.get', { session: id });

  const [started] = ctx.port.sessionRequests;

  invariant(started !== undefined);

  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  const adopted = await daemon.client.sendRequest('session.get', { session: id });

  expect(rebound).toStrictEqual({ revision: 2, restartPending: [id] });

  expect(getRecord(pending, 'session')).toMatchObject({
    alive: false,
    lastMsg: 'auth revision 2 applies at the next launch',
  });

  expect(ctx.port.getProcessArgv(started.name, started.session)).toStrictEqual([
    'sh',
    '-c',
    'echo "revision 2"; exec sleep 30',
  ]);

  expect(getRecord(adopted, 'session')).toMatchObject({ alive: true, lastMsg: 'revived' });

  expect<readonly unknown[]>(ctx.port.sessionRequests).toStrictEqual([
    expect.objectContaining({
      kind: 'start',
      argv: ['sh', '-c', 'echo "revision 1"; exec sleep 30'],
    }),
    expect.objectContaining({
      kind: 'start',
      argv: ['sh', '-c', 'echo "revision 2"; exec sleep 30'],
    }),
    expect.objectContaining({
      kind: 'start',
      argv: ['sh', '-c', 'echo "revision 2"; exec sleep 30'],
    }),
  ]);
});

test('it refuses an adopt whose outdated harness ignores its kill, leaves the session exited and blocks a second adopt', async () => {
  const ctx = setupTest();
  let judgeSelected = false;
  let ignoresHangup = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
    ignoresHangup: () => ignoresHangup,
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

      // The kill waits this long for an exit that never comes.
      failedSpawnExitWaitMs: 100,
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const [started] = ctx.port.sessionRequests;

  invariant(started !== undefined);

  // The harness prints its revision only after it ignores the hangup, so a
  // kill sent before that output would end it.
  await waitFor(() => {
    expect(ctx.port.getEnd(started.name, started.session)).toBeGreaterThan(0);
  });

  // The kill puts the imp to sleep with the harness kept inside it.
  await daemon.client.sendRequest('session.kill', { session: id });

  judgeSelected = true;
  ignoresHangup = false;

  await daemon.client.sendRequest('session.auth.rebind', { session: id });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(adopt).rejects.toMatchObject({ code: 'session_dead' });

  const got = await daemon.client.sendRequest('session.get', { session: id });

  const again = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(again).rejects.toMatchObject({ code: 'no_such_session' });
  expect(getRecord(got, 'session')).toMatchObject({ alive: false, lastMsg: 'killed' });

  expect(ctx.port.getProcessArgv(started.name, started.session)).toStrictEqual([
    'sh',
    '-c',
    `trap '' HUP; echo "revision 1"; exec sleep 30`,
  ]);

  expect(ctx.port.sessionRequests).toHaveLength(2);
});

test('it records an adopt whose outdated harness ignores its kill as stopped, so a restore after a daemon restart starts nothing', async () => {
  const ctx = setupTest();
  let judgeSelected = false;
  let ignoresHangup = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
    ignoresHangup: () => ignoresHangup,
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

      // The kill waits this long for an exit that never comes.
      failedSpawnExitWaitMs: 100,
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const [started] = ctx.port.sessionRequests;

  invariant(started !== undefined);

  // The harness prints its revision only after it ignores the hangup, so a
  // kill sent before that output would end it.
  await waitFor(() => {
    expect(ctx.port.getEnd(started.name, started.session)).toBeGreaterThan(0);
  });

  // The kill puts the imp to sleep with the harness kept inside it.
  await daemon.client.sendRequest('session.kill', { session: id });

  judgeSelected = true;
  ignoresHangup = false;

  await daemon.client.sendRequest('session.auth.rebind', { session: id });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(adopt).rejects.toMatchObject({ code: 'session_dead' });

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect(getRecord(got, 'session')).toMatchObject({
    alive: false,
    lifecycle: { desired: 'stop' },
  });

  expect(ctx.port.sessionRequests).toHaveLength(2);
});

test('it lists a running harness as pending a restart after a rebind and leaves it running', async () => {
  const ctx = setupTest();
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  judgeSelected = true;

  const rebound = await daemon.client.sendRequest('session.auth.rebind', { session: id });
  const got = await daemon.client.sendRequest('session.get', { session: id });

  const [started] = ctx.port.sessionRequests;

  invariant(started !== undefined);

  expect(rebound).toStrictEqual({ revision: 2, restartPending: [id] });

  expect(getRecord(got, 'session')).toMatchObject({
    alive: true,
    lastMsg: 'auth revision 2 applies at the next launch',
  });

  expect(ctx.port.getProcessArgv(started.name, started.session)).toStrictEqual([
    'sh',
    '-c',
    'echo "revision 1"; exec sleep 30',
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

test('it restores every session on a host whose agent added a profile on a target that rebinds a changed selection, granting it at the next revision', async () => {
  const ctx = setupTest({ rebindChangedAuth: true });
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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
      restoreBootTimeoutMs: 10,
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  const child = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a2',
    parent: parentID,
  });

  const childID = String(getRecord(child, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  // The stub agent never reports it booted, so the restore starts the
  // sub-session once the parent's boot cap runs out.
  await waitFor(async () => {
    const got = await daemon.client.sendRequest('session.get', { session: childID });

    expect(getRecord(got, 'session')['kind']).toBe('pty');
  });

  const listed = await daemon.client.sendRequest('session.list');
  const grants = await ctx.port.readGrants(imp);
  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  const binding = await store.findAuthBinding(toSessionID(parentID));

  expect(listed).toStrictEqual({
    sessions: expect.toIncludeSameMembers([
      expect.objectContaining({ id: parentID, kind: 'pty', alive: true }),
      expect.objectContaining({ id: childID, kind: 'pty', alive: true }),
    ]),
  });

  expect(grants).toIncludeSameMembers(['glm', 'judge']);
  expect(binding).toMatchObject({ state: 'ready', revision: 2 });
});

test('it revokes the grant of a dropped profile as it restores a session on a target that rebinds a changed selection', async () => {
  const ctx = setupTest({ rebindChangedAuth: true });
  let judgeSelected = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  judgeSelected = false;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: id });
  const grants = await ctx.port.readGrants(imp);

  expect(getRecord(got, 'session')).toMatchObject({ kind: 'pty', alive: true });
  expect(grants).toStrictEqual(['glm']);
});

test('it refuses to restore a session whose agent added a profile on a target that leaves a changed selection to a rebind', async () => {
  const ctx = setupTest({ rebindChangedAuth: false });
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const imp = getOnlyImpName(ctx.port);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: id });
  const grants = await ctx.port.readGrants(imp);

  const adopted = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(getRecord(got, 'session')['kind']).toBe('headless');
  expect(grants).toStrictEqual(['glm']);
  expect(adopted).rejects.toMatchObject({ code: 'auth_rebind_required' });
});

test('it lists a restore refused for a changed auth selection with the rebind hint and reports it in the restart check', async () => {
  const ctx = setupTest({ rebindChangedAuth: false });
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    name: 'cloud-review',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  judgeSelected = true;

  await daemon.restart();

  const verdict = await verifyRestoredFleet(
    daemon.client,
    60,
    [{ id, name: 'cloud-review', exited: false, agentSessionID: 'a1' }],
    systemClock,
    15_000,
  );

  const got = await daemon.client.sendRequest('session.get', { session: id });

  const refusal = `the auth profiles host ${id} uses changed since it was bound; rebind it to adopt them. Fix: atc session rebind ${id} (MCP: atc_session_auth_rebind), then atc session adopt ${id} (MCP: atc_session_adopt)`;

  expect(getRecord(got, 'session')).toMatchObject({
    kind: 'headless',
    lastMsg: refusal,
    restoreRefusal: 'auth_rebind_required',
  });

  expect(verdict).toStrictEqual({
    total: 1,
    failed: [
      {
        name: 'cloud-review',
        id,
        reason: `restore refused (auth_rebind_required): ${refusal}`,
      },
    ],
  });
});

test('it reports a restore refused for a dropped auth block in the restart check', async () => {
  const ctx = setupTest();
  let authSelected = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: false,
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
    name: 'gateway-docs',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  authSelected = false;

  await daemon.restart();

  const verdict = await verifyRestoredFleet(
    daemon.client,
    60,
    [{ id, name: 'gateway-docs', exited: false, agentSessionID: 'a1' }],
    systemClock,
    15_000,
  );

  expect(verdict).toStrictEqual({
    total: 1,
    failed: [
      {
        name: 'gateway-docs',
        id,
        reason: `restore refused (auth_rebind_required): agent 'glm' takes no credential from impd's broker, but its host holds a runtime auth binding; give the agent its auth block back, or forget the session. Once the auth block is back: atc session adopt ${id} (MCP: atc_session_adopt)`,
      },
    ],
  });
});

test('it refuses to restore a session whose agent dropped the broker credential on a target that rebinds a changed selection', async () => {
  const ctx = setupTest({ rebindChangedAuth: true });
  let authSelected = true;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: false,
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

  authSelected = false;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: id });
  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  const binding = await store.findAuthBinding(toSessionID(id));

  const adopted = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(getRecord(got, 'session')['kind']).toBe('headless');
  expect(binding).toMatchObject({ state: 'ready', revision: 1 });
  expect(adopted).rejects.toMatchObject({ code: 'auth_rebind_required' });
});

test('it refuses to restore a session whose agent added a profile on a target that rebinds a changed selection while another agent shares its host', async () => {
  const ctx = setupTest({ rebindChangedAuth: true });
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
  });

  const kimi = buildStubBrokeredAgentAdapter({
    id: 'kimi',
    brokerRequired: true,
    isSelected: () => true,
  });

  const daemon = await startTestDaemon({
    prefix: 'atc-runtime-auth-daemon-',
    options: () => ({
      adapter: glm,
      adapters: [glm, kimi],
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

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'kimi',
    target: 'box',
    resume: 'a2',
    parent: parentID,
  });

  const imp = getOnlyImpName(ctx.port);

  judgeSelected = true;

  await daemon.restart();
  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const adopted = daemon.client.sendRequest('session.adopt', {
    session: parentID,
    cols: 80,
    rows: 24,
  });

  expect(adopted).rejects.toMatchObject({ code: 'auth_rebind_required' });

  const grants = await ctx.port.readGrants(imp);

  expect(grants).toStrictEqual(['glm']);
});

test('it shows a running harness on the host that its auth revision applies at the next launch once a revive rebinds a changed selection', async () => {
  const ctx = setupTest({ rebindChangedAuth: true });
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  const child = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a2',
    parent: parentID,
  });

  const childID = String(getRecord(child, 'session')['id']);

  const childStart = ctx.port.sessionRequests.find(
    (request) => request.kind === 'start' && request.env['ATC_SESSION_ID'] === childID,
  );

  invariant(childStart?.kind === 'start', 'the sub-session sent no start request');

  const childSocket = childStart.env['ATC_SOCKET'];

  invariant(childSocket !== undefined, 'the sub-session started without a hook socket');

  await daemon.client.sendRequest('session.kill', { session: childID });

  // A kill answers before the harness's process ends, and a revive before
  // that end would attach to the dying process. The hook socket goes once
  // the end has run.
  await waitFor(() => {
    expect(existsSync(childSocket)).toBeFalse();
  });

  judgeSelected = true;

  await daemon.client.sendRequest('session.adopt', { session: childID, cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: parentID });

  expect(getRecord(got, 'session')).toMatchObject({
    alive: true,
    lastMsg: 'auth revision 2 applies at the next launch',
  });
});

test('it shows every restored harness on a host that rebinds during the first restore that its auth revision applies at the next launch', async () => {
  const ctx = setupTest({ rebindChangedAuth: true });
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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
      restoreBootTimeoutMs: 10,
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  const child = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a2',
    parent: parentID,
  });

  const childID = String(getRecord(child, 'session')['id']);

  judgeSelected = true;

  await daemon.restart();

  const logged = daemon.logs.length;

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  // A revive logs its wake once its harness's start settles and its launch
  // revision is recorded. The stub agent never reports it booted, so the
  // restore starts the sub-session once the parent's boot cap runs out.
  await waitFor(() => {
    const woken = daemon.logs.slice(logged).filter((line) => line.startsWith('atc: wake of'));

    expect(woken).toHaveLength(2);
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({
    sessions: expect.toIncludeSameMembers([
      expect.objectContaining({
        id: parentID,
        kind: 'pty',
        lastMsg: 'auth revision 2 applies at the next launch',
      }),
      expect.objectContaining({
        id: childID,
        kind: 'pty',
        lastMsg: 'auth revision 2 applies at the next launch',
      }),
    ]),
  });
});

test('it shows a harness restored after a daemon restart that its auth revision applies at the next launch, and not a harness that launched under the rebind', async () => {
  const ctx = setupTest({ rebindChangedAuth: true });
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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
      restoreBootTimeoutMs: 10,
    }),
  });

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const parent = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  const child = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a2',
    parent: parentID,
  });

  const childID = String(getRecord(child, 'session')['id']);

  const childStart = ctx.port.sessionRequests.find(
    (request) => request.kind === 'start' && request.env['ATC_SESSION_ID'] === childID,
  );

  invariant(childStart?.kind === 'start', 'the sub-session sent no start request');

  const childSocket = childStart.env['ATC_SOCKET'];

  invariant(childSocket !== undefined, 'the sub-session started without a hook socket');

  await daemon.client.sendRequest('session.kill', { session: childID });

  // A kill answers before the harness's process ends, and a revive before
  // that end would attach to the dying process. The hook socket goes once
  // the end has run.
  await waitFor(() => {
    expect(existsSync(childSocket)).toBeFalse();
  });

  judgeSelected = true;

  // The revive rebinds the host to revision 2 and starts the sub-session's
  // harness under it, while the parent's harness keeps revision 1.
  await daemon.client.sendRequest('session.adopt', { session: childID, cols: 80, rows: 24 });
  await daemon.restart();

  const logged = daemon.logs.length;

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  // A revive logs its wake once its harness's start settles and its launch
  // revision is recorded.
  await waitFor(() => {
    const woken = daemon.logs.slice(logged).filter((line) => line.startsWith('atc: wake of'));

    expect(woken).toHaveLength(2);
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed).toStrictEqual({
    sessions: expect.toIncludeSameMembers([
      expect.objectContaining({
        id: parentID,
        kind: 'pty',
        lastMsg: 'auth revision 2 applies at the next launch',
      }),
      expect.objectContaining({
        id: childID,
        kind: 'pty',
        lastMsg: 'revived',
      }),
    ]),
  });
});

test('it restarts a suspended harness under the revision a revive rebinds a changed selection to', async () => {
  const ctx = setupTest({ rebindChangedAuth: true });
  let judgeSelected = false;

  const glm = buildStubBrokeredAgentAdapter({
    id: 'glm',
    brokerRequired: true,
    isSelected: () => true,
    isJudgeSelected: () => judgeSelected,
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

  // The token may grant glm and judge, and impd holds glm for api.z.ai and
  // judge for judge.example.
  ctx.port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['glm', 'judge'],
  });

  ctx.port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  ctx.port.createSecret('judge', 'custom', [
    { host: 'judge.example', header: 'authorization', scheme: 'bearer' },
  ]);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  // The kill puts the imp to sleep with the harness kept inside it.
  await daemon.client.sendRequest('session.kill', { session: id });

  judgeSelected = true;

  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  const got = await daemon.client.sendRequest('session.get', { session: id });

  const [started] = ctx.port.sessionRequests;

  invariant(started !== undefined);

  expect(getRecord(got, 'session')).toMatchObject({ kind: 'pty', lastMsg: 'revived' });

  expect(ctx.port.getProcessArgv(started.name, started.session)).toStrictEqual([
    'sh',
    '-c',
    'echo "revision 2"; exec sleep 30',
  ]);
});
