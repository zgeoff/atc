import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { getAgentEntry } from '../../test/get-agent-entry';
import { getGatewayConfig } from '../../test/get-gateway-config';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

async function setupTest(targetTrust?: boolean) {
  const tmp = setupTempDir('atc-workspace-trust-');
  const guestDir = join(tmp.dir, 'guest');
  const marker = join(tmp.dir, 'started');
  const fakeClaude = join(tmp.dir, 'fake-claude');
  const guestATC = join(tmp.dir, 'atc');
  const upstream = join(tmp.dir, 'upstream.git');
  const work = join(tmp.dir, 'work');

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();
  await $`git config user.name atc`.env(env).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(env).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(env).cwd(work).quiet();

  writeFileSync(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  writeFileSync(fakeClaude, `#!/bin/sh\necho started >> "${marker}"\nexec sleep 30\n`, {
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

  const provider = new ImpProvider(
    port,
    {
      guestDir,
      guestATC,
    },
    { atcBinary: null },
  );

  const config = parseConfig({
    claudeBin: fakeClaude,
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    gateways: {
      glm: {
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
    },
  });

  const adapter = new GatewayAdapter(getGatewayConfig(config, 'glm'), config);

  const socketPath = join(tmp.dir, 'daemon.sock');

  const daemon = await startDaemon({
    socketPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapters: [adapter, new ClaudeAdapter(getAgentEntry(config, 'claude'), config)],
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    gitTransports: ['file'],
    targets: [
      {
        id: 'box',
        kind: 'imp',
        options: targetTrust === undefined ? {} : { trustClonedWorkspace: targetTrust },
        identity: 'imp:test',
        provider,
      },
      {
        id: 'local',
        kind: 'local-pty',
        options: targetTrust === undefined ? {} : { trustClonedWorkspace: targetTrust },
        identity: 'local:test',
        provider: new LocalPTYProvider(),
      },
    ],
    defaultTarget: 'box',
  });

  const client = await DaemonClient.open(socketPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    port,
    guestDir,
    marker,
    work,
    dir: tmp.dir,
    async [Symbol.asyncDispose]() {
      port.stopCommandHold();
      client.stop();

      await daemon.stop();

      provider.dispose();
      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test('it trusts only the resolved cloned root after an opted-in brokered launch', async () => {
  await using daemon = await setupTest();

  const parent = join(daemon.dir, 'physical');
  const alias = join(daemon.dir, 'alias');

  mkdirSync(parent);
  symlinkSync(parent, alias);

  const root = join(parent, 'clone');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: join(alias, 'clone'),
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
  });

  await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const config: unknown = JSON.parse(
    readFileSync(join(daemon.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
  );

  const [start] = daemon.port.sessionRequests;

  if (start?.kind !== 'start') {
    throw new Error('expected harness start');
  }

  expect(config).toStrictEqual({
    hasCompletedOnboarding: true,
    projects: { [root]: { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
  });

  expect(start.argv).toIncludeAllMembers(['--permission-mode', 'default']);
  expect(start.argv).not.toInclude('--dangerously-skip-permissions');
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('hello\n');
});

test.each([undefined, false])(
  'it leaves cloned workspaces untrusted with opt-in %s',
  async (enabled) => {
    await using daemon = await setupTest();

    const spawned = await daemon.client.sendRequest('session.spawn', {
      ...(enabled === undefined ? {} : { trustClonedWorkspace: enabled }),
      cwd: join(daemon.dir, 'clone'),
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: daemon.work },
    });

    await waitFor(() => {
      expect(existsSync(daemon.marker)).toBeTrue();

      return true;
    });

    const id = String(getRecord(spawned, 'session')['id']);

    const config: unknown = JSON.parse(
      readFileSync(join(daemon.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
    );

    expect(config).toStrictEqual({ hasCompletedOnboarding: true });
  },
);

test('it refuses trust for an existing folder before touching the imp', async () => {
  await using daemon = await setupTest();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });

  await spawn.catch(() => null);

  expect(daemon.port.calls).toStrictEqual([]);
});

test.each([
  [undefined, true],
  [true, undefined],
] as const)(
  'it does not seed trust before clone verification or launch after a mismatch with target %s and launch %s',
  async (targetTrust, launchTrust) => {
    await using daemon = await setupTest(targetTrust);

    const hold = daemon.port.startCommandHold('rev-parse');
    const root = join(daemon.dir, 'clone');

    const spawn = daemon.client.sendRequest('session.spawn', {
      ...(launchTrust === undefined ? {} : { trustClonedWorkspace: launchTrust }),
      cwd: root,
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: daemon.work },
    });

    await hold.entered;

    const [id] = readdirSync(join(daemon.guestDir, 'sessions'));

    if (id === undefined) {
      throw new Error('expected prepared guest');
    }

    const seed: unknown = JSON.parse(
      readFileSync(join(daemon.guestDir, 'sessions', id, 'claude-config-seed.json'), 'utf8'),
    );

    writeFileSync(join(root, 'README.md'), 'changed\n');

    hold.stop();

    expect(seed).toStrictEqual({ hasCompletedOnboarding: true });

    expect(spawn).rejects.toMatchObject({
      code: 'workspace_mismatch',
      data: { phase: 'verifying' },
    });

    await spawn.catch(() => null);

    expect(daemon.port.sessionRequests).toStrictEqual([]);
    expect(existsSync(daemon.marker)).toBeFalse();
  },
);

test('it refuses clone trust for stock Claude on an imp target before preparing a host', async () => {
  await using daemon = await setupTest();

  const root = join(daemon.dir, 'clone');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({ code: 'unsupported' });

  await spawn.catch(() => null);

  expect(daemon.port.calls).toStrictEqual([]);
  expect(existsSync(root)).toBeFalse();
  expect(existsSync(daemon.marker)).toBeFalse();
});

test('it refuses clone trust for a gateway on the local target before cloning', async () => {
  await using daemon = await setupTest();

  const root = join(daemon.dir, 'clone');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'glm',
    target: 'local',
    workspace: { kind: 'path', path: daemon.work },
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });

  await spawn.catch(() => null);

  expect(existsSync(root)).toBeFalse();
  expect(existsSync(daemon.marker)).toBeFalse();
});

test.each([
  [undefined, true],
  [true, undefined],
] as const)(
  'it preserves an existing guest config byte for byte during an opted-in clone launch with target %s and launch %s',
  async (targetTrust, launchTrust) => {
    await using daemon = await setupTest(targetTrust);

    const hold = daemon.port.startCommandHold('rev-parse');

    const existing =
      '{"hasCompletedOnboarding":true,"projects":{"/previous":{"hasTrustDialogAccepted":false}},"custom":"preserve"}\n';

    const spawn = daemon.client.sendRequest('session.spawn', {
      cwd: join(daemon.dir, 'clone'),
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: daemon.work },
      ...(launchTrust === undefined ? {} : { trustClonedWorkspace: launchTrust }),
    });

    await hold.entered;

    const [id] = readdirSync(join(daemon.guestDir, 'sessions'));

    if (id === undefined) {
      throw new Error('expected prepared guest');
    }

    const configDir = join(daemon.guestDir, 'sessions', id, 'claude-config');

    mkdirSync(configDir);
    writeFileSync(join(configDir, '.claude.json'), existing);

    hold.stop();

    await spawn;

    await waitFor(() => {
      expect(existsSync(daemon.marker)).toBeTrue();

      return true;
    });

    expect(readFileSync(join(configDir, '.claude.json'), 'utf8')).toBe(existing);
  },
);

test.each([
  [undefined, true],
  [true, undefined],
] as const)(
  'it removes a child clone after trust-seed transfer fails and permits a keyed retry with target %s and launch %s',
  async (targetTrust, launchTrust) => {
    await using daemon = await setupTest(targetTrust);

    const parent = await daemon.client.sendRequest('session.spawn', {
      cwd: daemon.work,
      agent: 'glm',
      target: 'box',
      trustClonedWorkspace: false,
    });

    const parentID = String(getRecord(parent, 'session')['id']);
    const root = join(daemon.dir, 'child');
    const hold = daemon.port.startCommandHold('rev-parse');

    const request = {
      cwd: root,
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace: { kind: 'path', path: daemon.work },
      ...(launchTrust === undefined ? {} : { trustClonedWorkspace: launchTrust }),
      idempotencyKey: 'trust-transfer-retry',
    };

    const spawn = daemon.client.sendRequest('session.spawn', request);

    await hold.entered;

    const id = readdirSync(join(daemon.guestDir, 'sessions')).find(
      (candidate) => candidate !== parentID,
    );

    if (id === undefined) {
      throw new Error('expected child guest');
    }

    const dir = join(daemon.guestDir, 'sessions', id);

    renameSync(dir, `${dir}-saved`);
    writeFileSync(dir, 'blocks seed transfer');

    hold.stop();

    expect(spawn).rejects.toThrow();

    await spawn.catch(() => null);

    expect(existsSync(root)).toBeFalse();

    const retried = await daemon.client.sendRequest('session.spawn', request);

    expect(getRecord(retried, 'session')).toMatchObject({ alive: true, parent: parentID });

    const parentState = await daemon.client.sendRequest('session.get', { session: parentID });

    expect(getRecord(parentState, 'session')).toMatchObject({ alive: true });
  },
);

test.each([
  [undefined, undefined, '{"hasCompletedOnboarding":true}'],
  [false, undefined, '{"hasCompletedOnboarding":true}'],
  [
    true,
    undefined,
    '{"hasCompletedOnboarding":true,"projects":{"ROOT":{"hasTrustDialogAccepted":true,"enableAllProjectMcpServers":true}}}',
  ],
  [undefined, false, '{"hasCompletedOnboarding":true}'],
  [false, false, '{"hasCompletedOnboarding":true}'],
  [true, false, '{"hasCompletedOnboarding":true}'],
  [
    undefined,
    true,
    '{"hasCompletedOnboarding":true,"projects":{"ROOT":{"hasTrustDialogAccepted":true,"enableAllProjectMcpServers":true}}}',
  ],
  [
    false,
    true,
    '{"hasCompletedOnboarding":true,"projects":{"ROOT":{"hasTrustDialogAccepted":true,"enableAllProjectMcpServers":true}}}',
  ],
  [
    true,
    true,
    '{"hasCompletedOnboarding":true,"projects":{"ROOT":{"hasTrustDialogAccepted":true,"enableAllProjectMcpServers":true}}}',
  ],
] as const)(
  'it resolves target trust %s and launch override %s to the expected config',
  async (targetTrust, launchTrust, expectedJSON) => {
    await using daemon = await setupTest(targetTrust);

    const root = join(daemon.dir, 'clone');

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: root,
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: daemon.work },
      ...(launchTrust === undefined ? {} : { trustClonedWorkspace: launchTrust }),
    });

    await waitFor(() => {
      expect(existsSync(daemon.marker)).toBeTrue();

      return true;
    });

    const id = String(getRecord(spawned, 'session')['id']);

    const config: unknown = JSON.parse(
      readFileSync(join(daemon.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
    );

    const expected: unknown = JSON.parse(expectedJSON.replace('ROOT', root));

    expect(config).toStrictEqual(expected);
  },
);

test('it refuses an inherited trust default without a clone before touching the imp', async () => {
  await using daemon = await setupTest(true);

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });

  await spawn.catch(() => null);

  expect(daemon.port.calls).toStrictEqual([]);
});

test('it refuses inherited clone trust for stock Claude on an imp target', async () => {
  await using daemon = await setupTest(true);

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'unsupported' });

  await spawn.catch(() => null);

  expect(daemon.port.calls).toStrictEqual([]);
});

test('it permits an ordinary folder launch when false overrides inherited trust', async () => {
  await using daemon = await setupTest(true);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'glm',
    target: 'box',
    trustClonedWorkspace: false,
  });

  await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const config: unknown = JSON.parse(
    readFileSync(join(daemon.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
  );

  expect(config).toStrictEqual({ hasCompletedOnboarding: true });
});
