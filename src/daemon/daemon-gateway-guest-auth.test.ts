import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { getGatewayConfig } from '../../test/get-gateway-config';
import { setupTempDir } from '../../test/setup-temp-dir';
import { updateEnv } from '../../test/update-env';
import { waitFor } from '../../test/wait-for';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A real daemon with a `local` target and an imp target `box` over a
 * fixture imp port whose impd an operator prepared: the token `atc-runtime`
 * manages `atc-*` imps and may grant `glm`, and impd holds `glm` for
 * api.z.ai as a custom bearer secret. The guest has an atc stand-in, so the
 * Claude gateways plan real guest spawns. Their binary is a fake claude
 * that records its arguments in a marker file. `glm` takes its credential
 * through `auth` with the bearer placeholder; `keyed` selects the same
 * profile with an `ANTHROPIC_API_KEY` placeholder; `proxied` is `glm` with
 * a proxy variable in its env, which the config would refuse. The canary
 * stands in for a credential held on the daemon's side.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-gateway-guest-auth-');
  const sockPath = join(tmp.dir, 'daemon.sock');
  const guestDir = join(tmp.dir, 'g');
  const fakeClaude = join(tmp.dir, 'fake-claude');
  const marker = join(tmp.dir, 'started');
  const guestATC = join(tmp.dir, 'atc');
  const canary = 'canary-sk-5d1c0a9e7b3f42';

  writeFileSync(fakeClaude, `#!/bin/sh\necho "$@" >> "${marker}"\nexec sleep 30\n`, {
    mode: 0o755,
  });

  writeFileSync(guestATC, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const port = new FixtureImpPort();

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

  const provider = new ImpProvider(port, { guestDir, guestATC }, { atcBinary: null });

  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    agents: {
      glm: {
        kind: 'claude',
        bin: fakeClaude,
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
      keyed: {
        kind: 'claude',
        bin: fakeClaude,
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_API_KEY: 'imp-broker-placeholder' },
        },
      },
    },
  });

  const gateways = buildAgentAdapters(config);
  const glm = getGatewayConfig(config, 'glm');

  const proxied = new GatewayAdapter(
    { ...glm, id: 'proxied', env: { HTTPS_PROXY: 'http://proxy.example:3128' } },
    config,
  );

  const daemon = await startDaemon({
    socketPath: sockPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapters: [...gateways, proxied],
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
    defaultTarget: 'box',
  });

  const client = await DaemonClient.open(sockPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    port,
    marker,
    canary,
    dir: tmp.dir,
    guestDir,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      provider.dispose();
      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it starts a brokered gateway on an imp under the settings file of its binding revision', async () => {
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(daemon.guestDir, 'sessions', id);

  await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });

  const [start] = daemon.port.sessionRequests;

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
  await using daemon = await setupTest();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(daemon.guestDir, 'sessions', id);

  await daemon.client.sendRequest('session.kill', { session: id });
  await daemon.client.sendRequest('session.auth.revoke', { session: id });
  await daemon.client.sendRequest('session.auth.rebind', { session: id });
  await daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(daemon.port.sessionRequests).toHaveLength(2);

    return true;
  });

  const [, revived] = daemon.port.sessionRequests;

  if (revived?.kind !== 'start') {
    throw new Error('expected the revived harness start');
  }

  expect(revived.argv).toContain(join(session, 'auth-r2', 'settings.json'));
  expect(revived.argv).not.toContain(join(session, 'auth-r1', 'settings.json'));
});

test('it refuses to revive a revoked session and starts no harness under its old settings', async () => {
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

  expect(adopt).rejects.toMatchObject({ code: 'auth_blocked' });

  await adopt.catch(() => null);

  expect(daemon.port.sessionRequests).toHaveLength(1);
});

test('it starts a brokered gateway with the placeholder and its own Claude config in the harness env and no credential anywhere', async () => {
  await using daemon = await setupTest();

  updateEnv('ANTHROPIC_API_KEY', daemon.canary);
  updateEnv('ANTHROPIC_AUTH_TOKEN', daemon.canary);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(daemon.guestDir, 'sessions', id);

  await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });

  const [start] = daemon.port.sessionRequests;

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
  expect(written).not.toInclude(daemon.canary);
  expect(JSON.stringify(start)).not.toInclude(daemon.canary);
});

test('it refuses a brokered gateway whose env sets a proxy variable before any imp call', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: '/tmp',
    agent: 'proxied',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'proxied', problem: 'guest_env_conflict', variable: 'HTTPS_PROXY' },
  });

  await spawn.catch(() => null);

  expect<Record<string, unknown>>({
    calls: daemon.port.calls,
    listed: await daemon.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: [], listed: { sessions: [] } });
});

test('it lists a brokered gateway with the bearer placeholder as spawnable and one with another placeholder as not', async () => {
  await using daemon = await setupTest();

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
  await using daemon = await setupTest();

  const cwd = join(daemon.dir, 'ws');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd,
    agent: 'keyed',
    target: 'box',
    workspace: { kind: 'path', path: join(daemon.dir, 'source') },
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_placeholder_unsupported',
    data: { agent: 'keyed' },
  });

  await spawn.catch(() => null);

  expect<Record<string, unknown>>({
    calls: daemon.port.calls,
    created: existsSync(cwd),
    hosts: existsSync(daemon.guestDir),
    listed: await daemon.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: [], created: false, hosts: false, listed: { sessions: [] } });
});

test('it refuses a brokered gateway on the local target before materializing its workspace or touching impd', async () => {
  await using daemon = await setupTest();

  const cwd = join(daemon.dir, 'ws');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd,
    agent: 'glm',
    target: 'local',
    workspace: { kind: 'path', path: join(daemon.dir, 'source') },
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', target: 'local' },
  });

  await spawn.catch(() => null);

  expect<Record<string, unknown>>({
    calls: daemon.port.calls,
    created: existsSync(cwd),
    started: existsSync(daemon.marker),
    listed: await daemon.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: [], created: false, started: false, listed: { sessions: [] } });
});
