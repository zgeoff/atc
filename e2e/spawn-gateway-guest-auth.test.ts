import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { ImpProvider } from '@atc/execution-imp';
import { createStubImpPort } from '@atc/execution-imp/testing';
import { LocalPTYProvider } from '@atc/execution-local';
import { GatewayAdapter } from '@atc/harness-claude';
import { getGatewayConfig } from '@atc/harness-claude/testing';
import {
  buildMockHostServices,
  createStubBin,
  createStubRecordingClaude,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  updateEnv,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildAgentAdapters } from '../packages/app/src/agents/build-agent-adapters';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

function setupTest() {
  const tmp = setupTempDir('atc-gateway-guest-auth-');
  const port = createStubImpPort();
  const fakeClaude = createStubRecordingClaude(tmp.path);

  // The imp provider hands the guest this atc binary, which prints the
  // daemon's version, so the guest's hooks run it.
  const guestATC = createStubBin(tmp.path, 'atc', '#!/bin/sh\necho 1.0.0\n');

  const provider = new ImpProvider(
    port,
    { guestDir: join(tmp.path, 'g'), guestATC },
    { atcBinary: null, version: '1.0.0' },
  );

  registerTestCleanup(() => {
    provider.dispose();
  });

  return {
    dir: tmp.path,
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
  };
}

test('it starts a brokered gateway on an imp under the settings file of its binding revision', async () => {
  const ctx = setupTest();

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

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
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
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
              },
            },
          },
        }),
        buildMockHostServices(),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(ctx.dir, 'g', 'sessions', id);

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'claude-starts.log'))).toBeTrue();
  });

  const [start] = ctx.port.sessionRequests;

  invariant(start?.kind === 'start', 'expected the harness start');

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

  expect(settings).toHaveProperty('env.ANTHROPIC_AUTH_TOKEN', 'broker-placeholder');
  expect(settings).not.toHaveProperty('apiKeyHelper');

  expect(seeded).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
  });
});

test('it revives a suspended session after a rebind as a fresh guest process under the settings file of the next revision', async () => {
  const ctx = setupTest();

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

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
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
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
              },
            },
          },
        }),
        buildMockHostServices(),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
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

  // The adopt attaches the harness the imp kept asleep, which launched
  // under the first revision, ends it, and starts a fresh one.
  await waitFor(() => {
    expect(ctx.port.sessionRequests).toHaveLength(3);
  });

  const revived = ctx.port.sessionRequests.at(2);

  invariant(revived?.kind === 'start', 'expected the revived harness start');

  const running = ctx.port.getProcessArgv(revived.name, revived.session);

  expect(running).toContain(join(session, 'auth-r2', 'settings.json'));
  expect(running).not.toContain(join(session, 'auth-r1', 'settings.json'));
});

test('it revives a suspended session after a rebind as a fresh guest process when the outdated one ended while its imp slept', async () => {
  const ctx = setupTest();

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

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
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
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
              },
            },
          },
        }),
        buildMockHostServices(),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(ctx.dir, 'g', 'sessions', id);

  await daemon.client.sendRequest('session.kill', { session: id });

  const [first] = ctx.port.sessionRequests;

  invariant(first !== undefined, 'expected the first harness start');

  // The process ends inside the sleeping imp, so the revive attaches an
  // exit nobody has received yet.
  ctx.port.killProcess(first.name, first.session);

  await waitFor(() => {
    expect(ctx.port.findUndeliveredExit(first.name, first.session)).not.toBeNull();
  });

  await daemon.client.sendRequest('session.auth.revoke', { session: id });
  await daemon.client.sendRequest('session.auth.rebind', { session: id });
  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  // The adopt attaches the ended harness and starts a fresh one in its place.
  await waitFor(() => {
    expect(ctx.port.sessionRequests).toHaveLength(3);
  });

  const revived = ctx.port.sessionRequests.at(2);

  invariant(revived?.kind === 'start', 'expected the revived harness start');

  const running = ctx.port.getProcessArgv(revived.name, revived.session);

  const listed = await daemon.client.sendRequest('session.list');

  expect(running).toContain(join(session, 'auth-r2', 'settings.json'));
  expect(running).not.toContain(join(session, 'auth-r1', 'settings.json'));
  expect(listed).toMatchObject({ sessions: [{ id, state: 'running' }] });
});

test('it refuses to revive a revoked session and starts no harness under its old settings', async () => {
  const ctx = setupTest();

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

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
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
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
              },
            },
          },
        }),
        buildMockHostServices(),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
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
  const ctx = setupTest();

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

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
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
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
              },
            },
          },
        }),
        buildMockHostServices(),
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
    cwd: daemon.directory,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(ctx.dir, 'g', 'sessions', id);

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'claude-starts.log'))).toBeTrue();
  });

  const [start] = ctx.port.sessionRequests;

  invariant(start?.kind === 'start', 'expected the harness start');

  const written = readdirSync(session, { recursive: true, encoding: 'utf8' })
    .map((path) => join(session, path))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  expect(start.env).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: 'broker-placeholder',
    CLAUDE_CONFIG_DIR: join(session, 'claude-config'),
    ATC_SESSION_ID: id,
  });

  expect(written).toInclude('broker-placeholder');
  expect(written).not.toInclude(canary);
  expect(JSON.stringify(start)).not.toInclude(canary);
});

test('it refuses a brokered gateway whose env sets a proxy variable before any imp call', async () => {
  const ctx = setupTest();

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

  const daemon = await startTestDaemon({
    options: () => {
      const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
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
              placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
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
            buildMockHostServices(),
          ),
        ],
        targets: ctx.targets,
        defaultTarget: 'box',
      };
    },
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    agent: 'proxied',
    target: 'box',
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'proxied', problem: 'guest_env_conflict', variable: 'HTTPS_PROXY' },
  });

  expect(ctx.port.calls).toStrictEqual([]);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it lists a brokered gateway with the bearer placeholder as spawnable and one with another placeholder as not', async () => {
  const ctx = setupTest();

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

  const daemon = await startTestDaemon({
    options: () => {
      const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
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
              placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
            },
          },
          keyed: {
            kind: 'claude',
            bin: ctx.fakeClaude,
            baseURL: 'https://api.z.ai/api/anthropic',
            auth: {
              profiles: ['glm'],
              placeholderEnv: { ANTHROPIC_API_KEY: 'broker-placeholder' },
            },
          },
        },
      });

      return {
        adapters: [
          ...buildAgentAdapters(config, buildMockHostServices()),

          // A proxy variable in a gateway's env, which the config would refuse.
          new GatewayAdapter(
            {
              ...getGatewayConfig(config, 'glm'),
              id: 'proxied',
              env: { HTTPS_PROXY: 'http://proxy.example:3128' },
            },
            config,
            buildMockHostServices(),
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
  const ctx = setupTest();

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

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
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
                placeholderEnv: { ANTHROPIC_API_KEY: 'broker-placeholder' },
              },
            },
          },
        }),
        buildMockHostServices(),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const cwd = join(daemon.directory, 'ws');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd,
    agent: 'keyed',
    target: 'box',
    workspace: { kind: 'path', path: join(daemon.directory, 'source') },
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'auth_placeholder_unsupported',
    data: { agent: 'keyed' },
  });

  expect(ctx.port.calls).toStrictEqual([]);
  expect(existsSync(cwd)).toBeFalse();
  expect(existsSync(join(ctx.dir, 'g'))).toBeFalse();
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a brokered gateway on the local target before materializing its workspace or touching impd', async () => {
  const ctx = setupTest();

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

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: buildAgentAdapters(
        parseConfig(SHIPPED_HARNESS_PLUGINS, {
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
                placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'broker-placeholder' },
              },
            },
          },
        }),
        buildMockHostServices(),
      ),
      targets: ctx.targets,
      defaultTarget: 'box',
    }),
  });

  const cwd = join(daemon.directory, 'ws');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd,
    agent: 'glm',
    target: 'local',
    workspace: { kind: 'path', path: join(daemon.directory, 'source') },
  });

  await Promise.allSettled([spawn]);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', target: 'local' },
  });

  expect(ctx.port.calls).toStrictEqual([]);
  expect(existsSync(cwd)).toBeFalse();
  expect(existsSync(join(ctx.dir, 'claude-starts.log'))).toBeFalse();
  expect(listed).toStrictEqual({ sessions: [] });
});
