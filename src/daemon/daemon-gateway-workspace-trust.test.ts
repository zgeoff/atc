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
import invariant from 'tiny-invariant';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubBin } from '../test-utils/create-stub-bin';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { createStubRecordingClaude } from '../test-utils/create-stub-recording-claude';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { getGatewayConfig } from '../test-utils/get-gateway-config';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

// The fixed parts every test's daemon runs on: a stub imp port behind
// the imp provider `box` serves, a local provider, a `glm` gateway and stock
// Claude, and a git repository a spawn can clone, in a temp directory. Each
// agent run appends its arguments to the `starts` log. `options` holds the
// daemon options besides its targets.
async function setupTest() {
  const tmp = setupTempDir('atc-workspace-trust-');
  const port = createStubImpPort();

  // A gateway launch on an imp needs a grantable broker secret for its
  // auth profile.
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

  const git = await createGitFixture({ prefix: 'atc-workspace-trust-git-' });

  // Each agent run records its start, so a test sees whether a launch went
  // ahead.
  const fakeClaude = createStubRecordingClaude(tmp.dir);

  // The imp provider installs this as the guest's atc.
  const guestATC = createStubBin(tmp.dir, 'atc', '#!/bin/sh\nexit 0\n');

  const box = new ImpProvider(
    port,
    { guestDir: join(tmp.dir, 'guest'), guestATC },
    { atcBinary: null },
  );

  registerTestCleanup(() => {
    box.dispose();
  });

  const agents = parseConfig({
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

  return {
    dir: tmp.dir,
    guestDir: join(tmp.dir, 'guest'),
    starts: join(tmp.dir, 'claude-starts.log'),
    port,
    work: git.work,
    box,
    local: new LocalPTYProvider(),
    options: {
      adapters: [
        new GatewayAdapter(getGatewayConfig(agents, 'glm'), agents),
        new ClaudeAdapter(getAgentEntry(agents, 'claude'), agents),
      ],
      gitTransports: ['file'],
      defaultTarget: 'box',
    },
  };
}

test('it trusts only the resolved cloned root after an opted-in brokered launch', async () => {
  const ctx = await setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      ...ctx.options,
      targets: [
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.box },
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: ctx.local,
        },
      ],
    }),
  });

  const parent = join(ctx.dir, 'physical');
  const alias = join(ctx.dir, 'alias');

  mkdirSync(parent);
  symlinkSync(parent, alias);

  const root = join(parent, 'clone');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: join(alias, 'clone'),
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const config: unknown = JSON.parse(
    readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
  );

  const [start] = ctx.port.sessionRequests;

  invariant(start?.kind === 'start', 'expected harness start');

  expect(config).toStrictEqual({
    hasCompletedOnboarding: true,
    projects: { [root]: { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
  });

  expect(start.argv).toIncludeAllMembers(['--permission-mode', 'default']);
  expect(start.argv).not.toContain('--dangerously-skip-permissions');

  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(
    readFileSync(join(ctx.work, 'README.md'), 'utf8'),
  );
});

test.each([
  ['unset', {}],
  ['false', { trustClonedWorkspace: false }],
])('it leaves cloned workspaces untrusted with opt-in %s', async (_label, launch) => {
  const ctx = await setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      ...ctx.options,
      targets: [
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.box },
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: ctx.local,
        },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    ...launch,
    cwd: join(ctx.dir, 'clone'),
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const config: unknown = JSON.parse(
    readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
  );

  expect(config).toStrictEqual({ hasCompletedOnboarding: true });
});

test('it refuses trust for an existing folder before touching the imp', async () => {
  const ctx = await setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      ...ctx.options,
      targets: [
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.box },
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: ctx.local,
        },
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test.each([
  ['unset', 'true', {}, { trustClonedWorkspace: true }],
  ['true', 'unset', { trustClonedWorkspace: true }, {}],
])(
  'it seeds no trust before the clone is verified with target %s and launch %s',
  async (_targetLabel, _launchLabel, targetOptions, launch) => {
    const ctx = await setupTest();

    const daemon = await startTestDaemon({
      options: () => ({
        ...ctx.options,
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: targetOptions,
            identity: 'imp:test',
            provider: ctx.box,
          },
          {
            id: 'local',
            kind: 'local-pty',
            options: targetOptions,
            identity: 'local:test',
            provider: ctx.local,
          },
        ],
      }),
    });

    const hold = ctx.port.startCommandHold('rev-parse');

    registerTestCleanup(() => {
      hold.stop();
    });

    const spawn = daemon.client.sendRequest('session.spawn', {
      ...launch,
      cwd: join(ctx.dir, 'clone'),
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    // The spawn goes on once the hold stops; settling it keeps a failure
    // from the daemon's disposal from going unhandled.
    void Promise.allSettled([spawn]);

    await hold.entered;

    const [id] = readdirSync(join(ctx.guestDir, 'sessions'));

    invariant(id !== undefined, 'expected prepared guest');

    const seed: unknown = JSON.parse(
      readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config-seed.json'), 'utf8'),
    );

    expect(seed).toStrictEqual({ hasCompletedOnboarding: true });
  },
);

test.each([
  ['unset', 'true', {}, { trustClonedWorkspace: true }],
  ['true', 'unset', { trustClonedWorkspace: true }, {}],
])(
  'it launches nothing once the clone no longer matches its source with target %s and launch %s',
  async (_targetLabel, _launchLabel, targetOptions, launch) => {
    const ctx = await setupTest();

    const daemon = await startTestDaemon({
      options: () => ({
        ...ctx.options,
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: targetOptions,
            identity: 'imp:test',
            provider: ctx.box,
          },
          {
            id: 'local',
            kind: 'local-pty',
            options: targetOptions,
            identity: 'local:test',
            provider: ctx.local,
          },
        ],
      }),
    });

    const hold = ctx.port.startCommandHold('rev-parse');

    registerTestCleanup(() => {
      hold.stop();
    });

    const root = join(ctx.dir, 'clone');

    const spawn = daemon.client.sendRequest('session.spawn', {
      ...launch,
      cwd: root,
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    await hold.entered;

    writeFileSync(join(root, 'README.md'), 'changed\n');

    hold.stop();

    await Promise.allSettled([spawn]);

    expect(spawn).rejects.toMatchObject({
      code: 'workspace_mismatch',
      data: { phase: 'verifying' },
    });

    expect(ctx.port.sessionRequests).toStrictEqual([]);
    expect(existsSync(ctx.starts)).toBeFalse();
  },
);

test('it refuses clone trust for stock Claude on an imp target before preparing a host', async () => {
  const ctx = await setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      ...ctx.options,
      targets: [
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.box },
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: ctx.local,
        },
      ],
    }),
  });

  const root = join(ctx.dir, 'clone');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({ code: 'unsupported' });
  expect(ctx.port.calls).toStrictEqual([]);
  expect(existsSync(root)).toBeFalse();
  expect(existsSync(ctx.starts)).toBeFalse();
});

test('it refuses clone trust for a gateway on the local target before cloning', async () => {
  const ctx = await setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      ...ctx.options,
      targets: [
        { id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider: ctx.box },
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: ctx.local,
        },
      ],
    }),
  });

  const root = join(ctx.dir, 'clone');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'glm',
    target: 'local',
    workspace: { kind: 'path', path: ctx.work },
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });
  expect(existsSync(root)).toBeFalse();
  expect(existsSync(ctx.starts)).toBeFalse();
});

test.each([
  ['unset', 'true', {}, { trustClonedWorkspace: true }],
  ['true', 'unset', { trustClonedWorkspace: true }, {}],
])(
  'it preserves an existing guest config byte for byte during an opted-in clone launch with target %s and launch %s',
  async (_targetLabel, _launchLabel, targetOptions, launch) => {
    const ctx = await setupTest();

    const daemon = await startTestDaemon({
      options: () => ({
        ...ctx.options,
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: targetOptions,
            identity: 'imp:test',
            provider: ctx.box,
          },
          {
            id: 'local',
            kind: 'local-pty',
            options: targetOptions,
            identity: 'local:test',
            provider: ctx.local,
          },
        ],
      }),
    });

    const hold = ctx.port.startCommandHold('rev-parse');

    registerTestCleanup(() => {
      hold.stop();
    });

    const existing =
      '{"hasCompletedOnboarding":true,"projects":{"/previous":{"hasTrustDialogAccepted":false}},"custom":"preserve"}\n';

    const spawn = daemon.client.sendRequest('session.spawn', {
      ...launch,
      cwd: join(ctx.dir, 'clone'),
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    await hold.entered;

    const [id] = readdirSync(join(ctx.guestDir, 'sessions'));

    invariant(id !== undefined, 'expected prepared guest');

    const configDir = join(ctx.guestDir, 'sessions', id, 'claude-config');

    mkdirSync(configDir);
    writeFileSync(join(configDir, '.claude.json'), existing);

    hold.stop();

    await spawn;

    await waitFor(() => {
      expect(existsSync(ctx.starts)).toBeTrue();
    });

    expect(readFileSync(join(configDir, '.claude.json'), 'utf8')).toBe(existing);
  },
);

test.each([
  ['unset', 'true', {}, { trustClonedWorkspace: true }],
  ['true', 'unset', { trustClonedWorkspace: true }, {}],
])(
  'it removes a child clone after the trust-seed transfer fails with target %s and launch %s',
  async (_targetLabel, _launchLabel, targetOptions, launch) => {
    const ctx = await setupTest();

    const daemon = await startTestDaemon({
      options: () => ({
        ...ctx.options,
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: targetOptions,
            identity: 'imp:test',
            provider: ctx.box,
          },
          {
            id: 'local',
            kind: 'local-pty',
            options: targetOptions,
            identity: 'local:test',
            provider: ctx.local,
          },
        ],
      }),
    });

    const parent = await daemon.client.sendRequest('session.spawn', {
      cwd: ctx.work,
      agent: 'glm',
      target: 'box',
      trustClonedWorkspace: false,
    });

    const parentID = String(getRecord(parent, 'session')['id']);
    const root = join(ctx.dir, 'child');
    const hold = ctx.port.startCommandHold('rev-parse');

    registerTestCleanup(() => {
      hold.stop();
    });

    const spawn = daemon.client.sendRequest('session.spawn', {
      ...launch,
      cwd: root,
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace: { kind: 'path', path: ctx.work },
    });

    await hold.entered;

    const id = readdirSync(join(ctx.guestDir, 'sessions')).find(
      (candidate) => candidate !== parentID,
    );

    invariant(id !== undefined, 'expected child guest');

    const guest = join(ctx.guestDir, 'sessions', id);

    renameSync(guest, `${guest}-saved`);
    writeFileSync(guest, 'blocks seed transfer');

    hold.stop();

    expect(spawn).rejects.toMatchObject({
      code: 'internal',
      message: `tar exited 1 unpacking into ${guest}`,
    });

    expect(existsSync(root)).toBeFalse();
  },
);

test.each([
  ['unset', 'true', {}, { trustClonedWorkspace: true }],
  ['true', 'unset', { trustClonedWorkspace: true }, {}],
])(
  'it permits a keyed retry of a child launch whose trust-seed transfer failed with target %s and launch %s',
  async (_targetLabel, _launchLabel, targetOptions, launch) => {
    const ctx = await setupTest();

    const daemon = await startTestDaemon({
      options: () => ({
        ...ctx.options,
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: targetOptions,
            identity: 'imp:test',
            provider: ctx.box,
          },
          {
            id: 'local',
            kind: 'local-pty',
            options: targetOptions,
            identity: 'local:test',
            provider: ctx.local,
          },
        ],
      }),
    });

    const parent = await daemon.client.sendRequest('session.spawn', {
      cwd: ctx.work,
      agent: 'glm',
      target: 'box',
      trustClonedWorkspace: false,
    });

    const parentID = String(getRecord(parent, 'session')['id']);
    const hold = ctx.port.startCommandHold('rev-parse');

    registerTestCleanup(() => {
      hold.stop();
    });

    const failed = daemon.client.sendRequest('session.spawn', {
      ...launch,
      cwd: join(ctx.dir, 'child'),
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'trust-transfer-retry',
    });

    await hold.entered;

    const id = readdirSync(join(ctx.guestDir, 'sessions')).find(
      (candidate) => candidate !== parentID,
    );

    invariant(id !== undefined, 'expected child guest');

    const guest = join(ctx.guestDir, 'sessions', id);

    renameSync(guest, `${guest}-saved`);
    writeFileSync(guest, 'blocks seed transfer');

    hold.stop();

    await Promise.allSettled([failed]);

    const retried = await daemon.client.sendRequest('session.spawn', {
      ...launch,
      cwd: join(ctx.dir, 'child'),
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'trust-transfer-retry',
    });

    const parentState = await daemon.client.sendRequest('session.get', { session: parentID });

    expect(getRecord(retried, 'session')).toMatchObject({ alive: true, parent: parentID });
    expect(getRecord(parentState, 'session')).toMatchObject({ alive: true });
  },
);

test.each([
  ['unset', 'unset', {}, {}],
  ['false', 'unset', { trustClonedWorkspace: false }, {}],
  ['unset', 'false', {}, { trustClonedWorkspace: false }],
  ['false', 'false', { trustClonedWorkspace: false }, { trustClonedWorkspace: false }],
  ['true', 'false', { trustClonedWorkspace: true }, { trustClonedWorkspace: false }],
])(
  'it leaves the clone untrusted for target trust %s and launch override %s',
  async (_targetLabel, _launchLabel, targetOptions, launch) => {
    const ctx = await setupTest();

    const daemon = await startTestDaemon({
      options: () => ({
        ...ctx.options,
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: targetOptions,
            identity: 'imp:test',
            provider: ctx.box,
          },
          {
            id: 'local',
            kind: 'local-pty',
            options: targetOptions,
            identity: 'local:test',
            provider: ctx.local,
          },
        ],
      }),
    });

    const spawned = await daemon.client.sendRequest('session.spawn', {
      ...launch,
      cwd: join(ctx.dir, 'clone'),
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    await waitFor(() => {
      expect(existsSync(ctx.starts)).toBeTrue();
    });

    const id = String(getRecord(spawned, 'session')['id']);

    const config: unknown = JSON.parse(
      readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
    );

    expect(config).toStrictEqual({ hasCompletedOnboarding: true });
  },
);

test.each([
  ['true', 'unset', { trustClonedWorkspace: true }, {}],
  ['unset', 'true', {}, { trustClonedWorkspace: true }],
  ['false', 'true', { trustClonedWorkspace: false }, { trustClonedWorkspace: true }],
  ['true', 'true', { trustClonedWorkspace: true }, { trustClonedWorkspace: true }],
])(
  'it trusts the clone for target trust %s and launch override %s',
  async (_targetLabel, _launchLabel, targetOptions, launch) => {
    const ctx = await setupTest();

    const daemon = await startTestDaemon({
      options: () => ({
        ...ctx.options,
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: targetOptions,
            identity: 'imp:test',
            provider: ctx.box,
          },
          {
            id: 'local',
            kind: 'local-pty',
            options: targetOptions,
            identity: 'local:test',
            provider: ctx.local,
          },
        ],
      }),
    });

    const root = join(ctx.dir, 'clone');

    const spawned = await daemon.client.sendRequest('session.spawn', {
      ...launch,
      cwd: root,
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    await waitFor(() => {
      expect(existsSync(ctx.starts)).toBeTrue();
    });

    const id = String(getRecord(spawned, 'session')['id']);

    const config: unknown = JSON.parse(
      readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
    );

    expect(config).toStrictEqual({
      hasCompletedOnboarding: true,
      projects: { [root]: { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
    });
  },
);

test('it refuses an inherited trust default without a clone before touching the imp', async () => {
  const ctx = await setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      ...ctx.options,
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: { trustClonedWorkspace: true },
          identity: 'imp:test',
          provider: ctx.box,
        },
        {
          id: 'local',
          kind: 'local-pty',
          options: { trustClonedWorkspace: true },
          identity: 'local:test',
          provider: ctx.local,
        },
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it refuses inherited clone trust for stock Claude on an imp target', async () => {
  const ctx = await setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      ...ctx.options,
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: { trustClonedWorkspace: true },
          identity: 'imp:test',
          provider: ctx.box,
        },
        {
          id: 'local',
          kind: 'local-pty',
          options: { trustClonedWorkspace: true },
          identity: 'local:test',
          provider: ctx.local,
        },
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'unsupported' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it permits an ordinary folder launch when false overrides inherited trust', async () => {
  const ctx = await setupTest();

  const daemon = await startTestDaemon({
    options: () => ({
      ...ctx.options,
      targets: [
        {
          id: 'box',
          kind: 'imp',
          options: { trustClonedWorkspace: true },
          identity: 'imp:test',
          provider: ctx.box,
        },
        {
          id: 'local',
          kind: 'local-pty',
          options: { trustClonedWorkspace: true },
          identity: 'local:test',
          provider: ctx.local,
        },
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
    trustClonedWorkspace: false,
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const config: unknown = JSON.parse(
    readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
  );

  expect(config).toStrictEqual({ hasCompletedOnboarding: true });
});
