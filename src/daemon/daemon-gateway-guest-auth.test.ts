import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAgentAdapters } from '../agents/build-agent-adapters';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { getGatewayConfig } from '../test-utils/get-gateway-config';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A real daemon with a `local` target and an imp target `box` over a
 * fixture imp port whose impd an operator prepared: the token `atc-runtime`
 * manages `atc-*` imps and may grant `glm`, and impd holds `glm` for
 * api.z.ai as a custom bearer secret. The guest has an atc stand-in under
 * `guestDir`'s parent, so the Claude gateways plan real guest spawns. Their
 * binary is a fake claude that appends its arguments to `marker`. `glm`
 * takes its credential through `auth` with the bearer placeholder; `keyed`
 * selects the same profile with an `ANTHROPIC_API_KEY` placeholder;
 * `proxied` is `glm` with a proxy variable in its env, which the config
 * would refuse. The three gateways are the agents of the config this daemon
 * serves.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const port = stack.use(new FixtureImpPort());

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

  const started = await startTestDaemon({
    prefix: 'atc-gateway-guest-auth-',
    options: (paths) => {
      // The gateways' binary and the guest's atc, which every spawn runs.
      writeFileSync(
        join(paths.dir, 'fake-claude'),
        `#!/bin/sh\necho "$@" >> "${join(paths.dir, 'started')}"\nexec sleep 30\n`,
        { mode: 0o755 },
      );

      writeFileSync(join(paths.dir, 'atc'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const provider = new ImpProvider(
        port,
        { guestDir: join(paths.dir, 'g'), guestATC: join(paths.dir, 'atc') },
        { atcBinary: null },
      );

      stack.defer(provider.dispose);

      const config = parseConfig({
        authProfiles: {
          glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
        },
        agents: {
          glm: {
            kind: 'claude',
            bin: join(paths.dir, 'fake-claude'),
            baseURL: 'https://api.z.ai/api/anthropic',
            auth: {
              profiles: ['glm'],
              placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
            },
          },
          keyed: {
            kind: 'claude',
            bin: join(paths.dir, 'fake-claude'),
            baseURL: 'https://api.z.ai/api/anthropic',
            auth: {
              profiles: ['glm'],
              placeholderEnv: { ANTHROPIC_API_KEY: 'imp-broker-placeholder' },
            },
          },
        },
      });

      const proxied = new GatewayAdapter(
        {
          ...getGatewayConfig(config, 'glm'),
          id: 'proxied',
          env: { HTTPS_PROXY: 'http://proxy.example:3128' },
        },
        config,
      );

      return {
        adapters: [...buildAgentAdapters(config), proxied],
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
      };
    },
  });

  const daemon = stack.use(started);
  const owned = stack.move();

  return {
    daemon,
    port,
    marker: join(daemon.dir, 'started'),
    guestDir: join(daemon.dir, 'g'),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it starts a brokered gateway on an imp under the settings file of its binding revision', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(ctx.guestDir, 'sessions', id);

  await waitFor(() => {
    expect(existsSync(ctx.marker)).toBeTrue();

    return true;
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
  await using ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(ctx.guestDir, 'sessions', id);

  await ctx.daemon.client.sendRequest('session.kill', { session: id });
  await ctx.daemon.client.sendRequest('session.auth.revoke', { session: id });
  await ctx.daemon.client.sendRequest('session.auth.rebind', { session: id });
  await ctx.daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  await waitFor(() => {
    expect(ctx.port.sessionRequests).toHaveLength(2);

    return true;
  });

  const [, revived] = ctx.port.sessionRequests;

  if (revived?.kind !== 'start') {
    throw new Error('expected the revived harness start');
  }

  expect(revived.argv).toContain(join(session, 'auth-r2', 'settings.json'));
  expect(revived.argv).not.toContain(join(session, 'auth-r1', 'settings.json'));
});

test('it refuses to revive a revoked session and starts no harness under its old settings', async () => {
  await using ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    agent: 'glm',
    target: 'box',
    resume: 'a1',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.kill', { session: id });
  await ctx.daemon.client.sendRequest('session.auth.revoke', { session: id });

  expect(
    ctx.daemon.client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 }),
  ).rejects.toMatchObject({ code: 'auth_blocked' });

  expect(ctx.port.sessionRequests).toHaveLength(1);
});

test('it starts a brokered gateway with the placeholder and its own Claude config in the harness env and no credential anywhere', async () => {
  await using ctx = await setupTest();

  // The canary stands in for a credential held on the daemon's side.
  const canary = 'canary-sk-5d1c0a9e7b3f42';

  updateEnv('ANTHROPIC_API_KEY', canary);
  updateEnv('ANTHROPIC_AUTH_TOKEN', canary);

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    agent: 'glm',
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const session = join(ctx.guestDir, 'sessions', id);

  await waitFor(() => {
    expect(existsSync(ctx.marker)).toBeTrue();

    return true;
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
  await using ctx = await setupTest();

  const spawn = ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.dir,
    agent: 'proxied',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'proxied', problem: 'guest_env_conflict', variable: 'HTTPS_PROXY' },
  });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    listed: await ctx.daemon.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: [], listed: { sessions: [] } });
});

test('it lists a brokered gateway with the bearer placeholder as spawnable and one with another placeholder as not', async () => {
  await using ctx = await setupTest();

  const listed = await ctx.daemon.client.sendRequest('agents.list');

  expect(listed).toMatchObject({
    agents: [
      { id: 'glm', capabilities: { spawn: true } },
      { id: 'keyed', capabilities: { spawn: false } },
      { id: 'proxied', capabilities: { spawn: false } },
    ],
  });
});

test('it refuses a brokered gateway with an unsupported placeholder before materializing its workspace or touching impd', async () => {
  await using ctx = await setupTest();

  const cwd = join(ctx.daemon.dir, 'ws');

  const spawn = ctx.daemon.client.sendRequest('session.spawn', {
    cwd,
    agent: 'keyed',
    target: 'box',
    workspace: { kind: 'path', path: join(ctx.daemon.dir, 'source') },
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_placeholder_unsupported',
    data: { agent: 'keyed' },
  });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    created: existsSync(cwd),
    hosts: existsSync(ctx.guestDir),
    listed: await ctx.daemon.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: [], created: false, hosts: false, listed: { sessions: [] } });
});

test('it refuses a brokered gateway on the local target before materializing its workspace or touching impd', async () => {
  await using ctx = await setupTest();

  const cwd = join(ctx.daemon.dir, 'ws');

  const spawn = ctx.daemon.client.sendRequest('session.spawn', {
    cwd,
    agent: 'glm',
    target: 'local',
    workspace: { kind: 'path', path: join(ctx.daemon.dir, 'source') },
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', target: 'local' },
  });

  expect<Record<string, unknown>>({
    calls: ctx.port.calls,
    created: existsSync(cwd),
    started: existsSync(ctx.marker),
    listed: await ctx.daemon.client.sendRequest('session.list'),
  }).toStrictEqual({ calls: [], created: false, started: false, listed: { sessions: [] } });
});
