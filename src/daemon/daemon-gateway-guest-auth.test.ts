import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { buildStubImpPort } from '../test-utils/build-stub-imp-port';
import { createStubBin } from '../test-utils/create-stub-bin';
import { createStubRecordingClaude } from '../test-utils/create-stub-recording-claude';
import { getGatewayConfig } from '../test-utils/get-gateway-config';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A stub imp port whose impd an operator prepared, and the targets a
 * daemon runs with over it: `local`, and an imp target `box` whose guest
 * folders live under `g`. The guest has an atc stand-in, so a Claude
 * gateway plans a real guest spawn. `fakeClaude` is a fake claude that
 * records each start in `claude-starts.log` under the directory.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-gateway-guest-auth-'));
  const port = stack.use(buildStubImpPort());

  // Every brokered spawn checks that the token may manage atc imps and
  // grant glm, and that impd holds glm for api.z.ai as a bearer secret.
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

  const fakeClaude = createStubRecordingClaude(tmp.dir);

  // The imp provider hands the guest this atc binary.
  const guestATC = createStubBin(tmp.dir, 'atc', '#!/bin/sh\nexit 0\n');

  const provider = new ImpProvider(
    port,
    { guestDir: join(tmp.dir, 'g'), guestATC },
    { atcBinary: null },
  );

  stack.defer(() => {
    provider.dispose();
  });

  const owned = stack.move();

  return {
    dir: tmp.dir,
    port,
    fakeClaude,
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
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it starts a brokered gateway on an imp under the settings file of its binding revision', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(ctx.dir, 'g', 'sessions', id);

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'claude-starts.log'))).toBeTrue();
  });

  const [start] = ctx.port.sessionRequests;

  if (start?.kind !== 'start') {
    throw new Error('expected the harness start');
  }

  const settings: unknown = JSON.parse(
    readFileSync(join(session, 'auth-r1', 'settings.json'), 'utf8'),
  );

  const seeded: unknown = JSON.parse(
    readFileSync(join(session, 'claude-config', '.claude.json'), 'utf8'),
  );

  expect(start.argv).toIncludeAllMembers([
    '--settings',
    join(session, 'auth-r1', 'settings.json'),
    '--permission-mode',
    'default',
  ]);

  expect(settings).toHaveProperty('env.ANTHROPIC_AUTH_TOKEN', 'imp-broker-placeholder');
  expect(settings).not.toHaveProperty('apiKeyHelper');
  expect(seeded).toStrictEqual({ hasCompletedOnboarding: true });
});

test('it revives a rebound session under the settings file of the next revision', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(ctx.dir, 'g', 'sessions', id);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.auth.revoke', { session: id });
  await daemon.client.sendRequest('session.auth.rebind', { session: id });
  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.sessionRequests).toHaveLength(2);
  });

  const [, revived] = ctx.port.sessionRequests;

  if (revived?.kind !== 'start') {
    throw new Error('expected the revived harness start');
  }

  expect(revived.argv).toContain(join(session, 'auth-r2', 'settings.json'));
  expect(revived.argv).not.toContain(join(session, 'auth-r1', 'settings.json'));
});

test('it refuses to revive a revoked session and starts no harness under its old settings', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.auth.revoke', { session: id });

  const adopt = daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await Promise.allSettled([adopt]);

  expect(adopt).rejects.toMatchObject({ code: 'auth_blocked' });
  expect(ctx.port.sessionRequests).toHaveLength(1);
});

test('it starts a brokered gateway with the placeholder and its own Claude config in the harness env and no credential anywhere', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  // The canary stands in for a credential held on the daemon's side.
  const canary = 'canary-sk-5d1c0a9e7b3f42';

  updateEnv('ANTHROPIC_API_KEY', canary);
  updateEnv('ANTHROPIC_AUTH_TOKEN', canary);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(ctx.dir, 'g', 'sessions', id);

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'claude-starts.log'))).toBeTrue();
  });

  const [start] = ctx.port.sessionRequests;

  if (start?.kind !== 'start') {
    throw new Error('expected the harness start');
  }

  const written = readdirSync(session, { recursive: true, encoding: 'utf8' })
    .map((path) => join(session, path))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  expect(start.env).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder',
    CLAUDE_CONFIG_DIR: join(session, 'claude-config'),
    ATC_SESSION_ID: id,
  });

  expect(written).toInclude('imp-broker-placeholder');
  expect(written).not.toInclude(canary);
  expect(JSON.stringify(start)).not.toInclude(canary);
});

test('it refuses a brokered gateway whose env sets a proxy variable before any imp call', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => {
      const config = parseConfig({
        authProfiles: {
          glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        },
        agents: {
          glm: {
            kind: 'claude',
            bin: ctx.fakeClaude,
            baseURL: 'https://api.z.ai/api/anthropic',
            auth: {
              profiles: ['glm'],
              placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
            },
          },
        },
      });

      return {
        adapters: [
          // A proxy variable in a gateway's env, which the config would refuse.
          new GatewayAdapter(
            {
              ...getGatewayConfig(config, 'glm'),
              id: 'proxied',
              env: { HTTPS_PROXY: 'http://proxy.example:3128' },
            },
            config,
          ),
        ],
        targets: ctx.targets,
        defaultTarget: 'box',
      };
    },
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    agent: 'proxied',
    target: 'box',
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'proxied', problem: 'guest_env_conflict', variable: 'HTTPS_PROXY' },
  });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    listed,
  }).toStrictEqual({ calls: [], listed: { sessions: [] } });
});

test('it lists a brokered gateway with the bearer placeholder as spawnable and one with another placeholder as not', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => {
      const config = parseConfig({
        authProfiles: {
          glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        },
        agents: {
          glm: {
            kind: 'claude',
            bin: ctx.fakeClaude,
            baseURL: 'https://api.z.ai/api/anthropic',
            auth: {
              profiles: ['glm'],
              placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
            },
          },
          keyed: {
            kind: 'claude',
            bin: ctx.fakeClaude,
            baseURL: 'https://api.z.ai/api/anthropic',
            auth: {
              profiles: ['glm'],
              placeholderEnv: { ANTHROPIC_API_KEY: 'imp-broker-placeholder' },
            },
          },
        },
      });

      return {
        adapters: [
          ...buildAgentAdapters(config),

          // A proxy variable in a gateway's env, which the config would refuse.
          new GatewayAdapter(
            {
              ...getGatewayConfig(config, 'glm'),
              id: 'proxied',
              env: { HTTPS_PROXY: 'http://proxy.example:3128' },
            },
            config,
          ),
        ],
        targets: ctx.targets,
        defaultTarget: 'box',
      };
    },
  });

  const listed = await daemon.client.sendRequest('agents.list');

  expect(listed).toMatchObject({
    agents: [
      { id: 'glm', capabilities: { spawn: true } },
      { id: 'keyed', capabilities: { spawn: false } },
      { id: 'proxied', capabilities: { spawn: false } },
    ],
  });
});

test('it refuses a brokered gateway with an unsupported placeholder before materializing its workspace or touching impd', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            keyed: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_API_KEY: 'imp-broker-placeholder' },
              },
            },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const cwd = join(daemon.dir, 'ws');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd,
    agent: 'keyed',
    target: 'box',
    workspace: { kind: 'path', path: join(daemon.dir, 'source') },
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'auth_placeholder_unsupported',
    data: { agent: 'keyed' },
  });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    created: existsSync(cwd),
    hosts: existsSync(join(ctx.dir, 'g')),
    listed,
  }).toStrictEqual({ calls: [], created: false, hosts: false, listed: { sessions: [] } });
});

test('it refuses a brokered gateway on the local target before materializing its workspace or touching impd', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig({
          authProfiles: {
            glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
          },
          agents: {
            glm: {
              kind: 'claude',
              bin: ctx.fakeClaude,
              baseURL: 'https://api.z.ai/api/anthropic',
              auth: {
                profiles: ['glm'],
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
              },
            },
          },
        }),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const cwd = join(daemon.dir, 'ws');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd,
    agent: 'glm',
    target: 'local',
    workspace: { kind: 'path', path: join(daemon.dir, 'source') },
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', target: 'local' },
  });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    created: existsSync(cwd),
    started: existsSync(join(ctx.dir, 'claude-starts.log')),
    listed,
  }).toStrictEqual({ calls: [], created: false, started: false, listed: { sessions: [] } });
});
