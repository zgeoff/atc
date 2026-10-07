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
import { ClaudeAdapter } from '../agents/claude-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubBin } from '../test-utils/create-stub-bin';
import { FixtureImpPort } from '../test-utils/fixture-imp-port';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { getGatewayConfig } from '../test-utils/get-gateway-config';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';
import { LocalPTYProvider } from './local-pty-provider';

interface TestConfig {
  // The options both the imp target `box` and the `local` target carry.
  readonly targetOptions?: Readonly<Record<string, unknown>>;
}

// A real daemon with a `glm` gateway and stock Claude, serving the imp
// target `box` over a fixture imp port and the `local` target, beside a git
// repository a spawn can clone. Each agent run appends a line to `marker`.
async function setupTest(config: TestConfig = {}) {
  await using stack = new AsyncDisposableStack();

  const port = stack.use(new FixtureImpPort());

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

  stack.use(git);

  const daemon = await startTestDaemon({
    prefix: 'atc-workspace-trust-',
    options: (paths) => {
      // Each agent run records that it started, so a test sees whether a
      // launch went ahead.
      const fakeClaude = createStubBin(
        paths.dir,
        'fake-claude',
        `#!/bin/sh\necho started >> "${join(paths.dir, 'started')}"\nexec sleep 30\n`,
      );

      // The imp provider installs this as the guest's atc.
      const guestATC = createStubBin(paths.dir, 'atc', '#!/bin/sh\nexit 0\n');

      const provider = new ImpProvider(
        port,
        { guestDir: join(paths.dir, 'guest'), guestATC },
        { atcBinary: null },
      );

      stack.defer(() => {
        provider.dispose();
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
        adapters: [
          new GatewayAdapter(getGatewayConfig(agents, 'glm'), agents),
          new ClaudeAdapter(getAgentEntry(agents, 'claude'), agents),
        ],
        gitTransports: ['file'],
        targets: [
          {
            id: 'box',
            kind: 'imp',
            options: config.targetOptions ?? {},
            identity: 'imp:test',
            provider,
          },
          {
            id: 'local',
            kind: 'local-pty',
            options: config.targetOptions ?? {},
            identity: 'local:test',
            provider: new LocalPTYProvider(),
          },
        ],
        defaultTarget: 'box',
      };
    },
  });

  stack.use(daemon);

  // A command a test holds would keep the daemon from stopping.
  stack.defer(() => {
    port.stopCommandHold();
  });

  const owned = stack.move();

  return {
    client: daemon.client,
    port,
    dir: daemon.dir,
    guestDir: join(daemon.dir, 'guest'),
    marker: join(daemon.dir, 'started'),
    work: git.work,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it trusts only the resolved cloned root after an opted-in brokered launch', async () => {
  await using ctx = await setupTest();

  const parent = join(ctx.dir, 'physical');
  const alias = join(ctx.dir, 'alias');

  mkdirSync(parent);
  symlinkSync(parent, alias);

  const root = join(parent, 'clone');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: join(alias, 'clone'),
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await waitFor(() => {
    expect(existsSync(ctx.marker)).toBeTrue();
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const config: unknown = JSON.parse(
    readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
  );

  const [start] = ctx.port.sessionRequests;

  if (start?.kind !== 'start') {
    throw new Error('expected harness start');
  }

  expect(config).toStrictEqual({
    hasCompletedOnboarding: true,
    projects: { [root]: { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
  });

  expect(start.argv).toIncludeAllMembers(['--permission-mode', 'default']);
  expect(start.argv).not.toInclude('--dangerously-skip-permissions');

  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(
    readFileSync(join(ctx.work, 'README.md'), 'utf8'),
  );
});

test.each([
  ['unset', {}],
  ['false', { trustClonedWorkspace: false }],
])('it leaves cloned workspaces untrusted with opt-in %s', async (_label, launch) => {
  await using ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    ...launch,
    cwd: join(ctx.dir, 'clone'),
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await waitFor(() => {
    expect(existsSync(ctx.marker)).toBeTrue();
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const config: unknown = JSON.parse(
    readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
  );

  expect(config).toStrictEqual({ hasCompletedOnboarding: true });
});

test('it refuses trust for an existing folder before touching the imp', async () => {
  await using ctx = await setupTest();

  const spawn = ctx.client.sendRequest('session.spawn', {
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
  'it does not seed trust before clone verification or launch after a mismatch with target %s and launch %s',
  async (_targetLabel, _launchLabel, targetOptions, launch) => {
    await using ctx = await setupTest({ targetOptions });

    const hold = ctx.port.startCommandHold('rev-parse');
    const root = join(ctx.dir, 'clone');

    const spawn = ctx.client.sendRequest('session.spawn', {
      ...launch,
      cwd: root,
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    await hold.entered;

    const [id] = readdirSync(join(ctx.guestDir, 'sessions'));

    if (id === undefined) {
      throw new Error('expected prepared guest');
    }

    const seed: unknown = JSON.parse(
      readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config-seed.json'), 'utf8'),
    );

    writeFileSync(join(root, 'README.md'), 'changed\n');

    hold.stop();

    expect(seed).toStrictEqual({ hasCompletedOnboarding: true });

    expect(spawn).rejects.toMatchObject({
      code: 'workspace_mismatch',
      data: { phase: 'verifying' },
    });

    expect(ctx.port.sessionRequests).toStrictEqual([]);
    expect(existsSync(ctx.marker)).toBeFalse();
  },
);

test('it refuses clone trust for stock Claude on an imp target before preparing a host', async () => {
  await using ctx = await setupTest();

  const root = join(ctx.dir, 'clone');

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({ code: 'unsupported' });
  expect(ctx.port.calls).toStrictEqual([]);
  expect(existsSync(root)).toBeFalse();
  expect(existsSync(ctx.marker)).toBeFalse();
});

test('it refuses clone trust for a gateway on the local target before cloning', async () => {
  await using ctx = await setupTest();

  const root = join(ctx.dir, 'clone');

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'glm',
    target: 'local',
    workspace: { kind: 'path', path: ctx.work },
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({ code: 'auth_target_unsupported' });
  expect(existsSync(root)).toBeFalse();
  expect(existsSync(ctx.marker)).toBeFalse();
});

test.each([
  ['unset', 'true', {}, { trustClonedWorkspace: true }],
  ['true', 'unset', { trustClonedWorkspace: true }, {}],
])(
  'it preserves an existing guest config byte for byte during an opted-in clone launch with target %s and launch %s',
  async (_targetLabel, _launchLabel, targetOptions, launch) => {
    await using ctx = await setupTest({ targetOptions });

    const hold = ctx.port.startCommandHold('rev-parse');

    const existing =
      '{"hasCompletedOnboarding":true,"projects":{"/previous":{"hasTrustDialogAccepted":false}},"custom":"preserve"}\n';

    const spawn = ctx.client.sendRequest('session.spawn', {
      ...launch,
      cwd: join(ctx.dir, 'clone'),
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    await hold.entered;

    const [id] = readdirSync(join(ctx.guestDir, 'sessions'));

    if (id === undefined) {
      throw new Error('expected prepared guest');
    }

    const configDir = join(ctx.guestDir, 'sessions', id, 'claude-config');

    mkdirSync(configDir);
    writeFileSync(join(configDir, '.claude.json'), existing);

    hold.stop();

    await spawn;

    await waitFor(() => {
      expect(existsSync(ctx.marker)).toBeTrue();
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
    await using ctx = await setupTest({ targetOptions });

    const parent = await ctx.client.sendRequest('session.spawn', {
      cwd: ctx.work,
      agent: 'glm',
      target: 'box',
      trustClonedWorkspace: false,
    });

    const parentID = String(getRecord(parent, 'session')['id']);
    const root = join(ctx.dir, 'child');
    const hold = ctx.port.startCommandHold('rev-parse');

    const spawn = ctx.client.sendRequest('session.spawn', {
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

    if (id === undefined) {
      throw new Error('expected child guest');
    }

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
    await using ctx = await setupTest({ targetOptions });

    const parent = await ctx.client.sendRequest('session.spawn', {
      cwd: ctx.work,
      agent: 'glm',
      target: 'box',
      trustClonedWorkspace: false,
    });

    const parentID = String(getRecord(parent, 'session')['id']);
    const hold = ctx.port.startCommandHold('rev-parse');

    const request = {
      ...launch,
      cwd: join(ctx.dir, 'child'),
      agent: 'glm',
      target: 'box',
      parent: parentID,
      workspace: { kind: 'path', path: ctx.work },
      idempotencyKey: 'trust-transfer-retry',
    };

    const failed = ctx.client.sendRequest('session.spawn', request);

    await hold.entered;

    const id = readdirSync(join(ctx.guestDir, 'sessions')).find(
      (candidate) => candidate !== parentID,
    );

    if (id === undefined) {
      throw new Error('expected child guest');
    }

    const guest = join(ctx.guestDir, 'sessions', id);

    renameSync(guest, `${guest}-saved`);
    writeFileSync(guest, 'blocks seed transfer');

    hold.stop();

    await Promise.allSettled([failed]);

    const retried = await ctx.client.sendRequest('session.spawn', request);
    const parentState = await ctx.client.sendRequest('session.get', { session: parentID });

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
    await using ctx = await setupTest({ targetOptions });

    const spawned = await ctx.client.sendRequest('session.spawn', {
      ...launch,
      cwd: join(ctx.dir, 'clone'),
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    await waitFor(() => {
      expect(existsSync(ctx.marker)).toBeTrue();
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
    await using ctx = await setupTest({ targetOptions });

    const root = join(ctx.dir, 'clone');

    const spawned = await ctx.client.sendRequest('session.spawn', {
      ...launch,
      cwd: root,
      agent: 'glm',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    await waitFor(() => {
      expect(existsSync(ctx.marker)).toBeTrue();
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
  await using ctx = await setupTest({ targetOptions: { trustClonedWorkspace: true } });

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it refuses inherited clone trust for stock Claude on an imp target', async () => {
  await using ctx = await setupTest({ targetOptions: { trustClonedWorkspace: true } });

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(spawn).rejects.toMatchObject({ code: 'unsupported' });
  expect(ctx.port.calls).toStrictEqual([]);
});

test('it permits an ordinary folder launch when false overrides inherited trust', async () => {
  await using ctx = await setupTest({ targetOptions: { trustClonedWorkspace: true } });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'glm',
    target: 'box',
    trustClonedWorkspace: false,
  });

  await waitFor(() => {
    expect(existsSync(ctx.marker)).toBeTrue();
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const config: unknown = JSON.parse(
    readFileSync(join(ctx.guestDir, 'sessions', id, 'claude-config', '.claude.json'), 'utf8'),
  );

  expect(config).toStrictEqual({ hasCompletedOnboarding: true });
});
