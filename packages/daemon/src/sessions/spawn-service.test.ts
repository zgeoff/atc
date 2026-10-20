import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock, toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { CommandSpec } from '@atc/plugin-api';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { createGitFixture, registerTestCleanup, setupTempDir, updateEnv } from '@atc/test-utils';
import { $ } from 'bun';
import { TargetAccess } from '../auth/target-access';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubLocalProvider } from '../testing/build-stub-local-provider';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { IdempotencyLedger } from '../transport/idempotency-ledger';
import { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';
import { SpawnService } from './spawn-service';

interface SetupTestConfig {
  readonly targets: readonly ExecutionTarget[];
  readonly defaultTarget: string | null;
  readonly workspaceRoots?: Readonly<{
    root: string | null;
    targetRoots: ReadonlyMap<string, string>;
  }>;

  // The transports a workspace may clone over; https and ssh when absent.
  readonly gitTransports?: readonly string[];
}

// A session manager over the targets given, with the stub harness as its
// one agent and a real state store, and the runtime the daemon gives each
// session it announces.
async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-spawn-service-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const runtimes = new Map<SessionID, SessionRuntime>();

  const mgr = new SessionManager(
    null,
    store,
    join(tmp.dir, 'status.json'),
    [buildStubHarnessAdapter()],
    config.targets,
    [],
    {
      onEvent: (kind, s) => {
        if (kind === 'added') {
          runtimes.set(s.id, new SessionRuntime());
        }
      },
    },
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const ledger = new IdempotencyLedger(store, 'local', () => {}, systemClock);

  const spawns = new SpawnService({
    mgr,
    store,
    clock: systemClock,
    ledger,
    findRuntime: (id) => runtimes.get(id),
    gitTransports: config.gitTransports ?? ['https', 'ssh'],
    defaultTarget: config.defaultTarget,
    ...(config.workspaceRoots === undefined ? {} : { workspaceRoots: config.workspaceRoots }),
    homeDir: '/home/wrangler',
  });

  return { dir: tmp.dir, store, mgr, runtimes, spawns };
}

test('it spawns a session on the target given and answers with its descriptor', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    defaultTarget: 'local',
  });

  const answer = await ctx.spawns.spawnSession(
    () => ({
      cwd: ctx.dir,
      name: 'builder',
      prompt: '',
      cols: 100,
      rows: 30,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: null,
      overrides: {},
      target: 'local',
      workspace: null,
      scope: null,
      autoDir: false,
    }),
    null,
    null,
  );

  expect(answer).toMatchObject({ session: { name: 'builder', cwd: ctx.dir, agent: 'claude' } });
  expect(answer).not.toContainKey('warnings');
  expect(provider.harnesses).toHaveLength(1);
});

test('it records the directory of a spawned session in the spawn history', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    defaultTarget: 'local',
  });

  await ctx.spawns.spawnSession(
    () => ({
      cwd: ctx.dir,
      name: 'builder',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: null,
      overrides: {},
      target: 'local',
      workspace: null,
      scope: null,
      autoDir: false,
    }),
    null,
    null,
  );

  const dirs = await ctx.store.readSpawnDirs();

  expect(dirs).toStrictEqual([
    { cwd: ctx.dir, grant: { target: 'local', targetIdentity: 'local-pty:test' } },
  ]);
});

test('it marks a spawned session to write the last-used agent once it starts', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    defaultTarget: 'local',
  });

  const answer = await ctx.spawns.spawnSession(
    () => ({
      cwd: ctx.dir,
      name: 'builder',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: null,
      overrides: {},
      target: 'local',
      workspace: null,
      scope: null,
      autoDir: false,
    }),
    null,
    null,
  );

  expect(ctx.runtimes.get(toSessionID(answer.session.id))?.pendingLastUsed).toBeTrue();
});

test('it answers a retried keyed spawn with the first session and spawns once', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    defaultTarget: 'local',
  });

  const plan = () =>
    ({
      cwd: ctx.dir,
      name: 'builder',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: null,
      overrides: {},
      target: 'local',
      workspace: null,
      scope: null,
      autoDir: false,
    }) as const;

  const first = await ctx.spawns.spawnSession(plan, { key: 'k-1', payloadHash: 'h-1' }, null);
  const second = await ctx.spawns.spawnSession(plan, { key: 'k-1', payloadHash: 'h-1' }, null);

  expect(second.session.id).toBe(first.session.id);
  expect(provider.harnesses).toHaveLength(1);
});

test('it refuses a spawn under a parent the access does not reach as an unknown session', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    defaultTarget: 'local',
  });

  const parent = await ctx.spawns.spawnSession(
    () => ({
      cwd: ctx.dir,
      name: 'lead',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: null,
      overrides: {},
      target: 'local',
      workspace: null,
      scope: null,
      autoDir: false,
    }),
    null,
    null,
  );

  const spawned = ctx.spawns.spawnSession(
    () => ({
      cwd: ctx.dir,
      name: 'helper',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: toSessionID(parent.session.id),
      overrides: {},
      target: 'local',
      workspace: null,
      scope: null,
      autoDir: false,
    }),
    null,
    new TargetAccess([]),
  );

  expect(spawned).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it resolves a spawn that names no target to the default target', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'box',
        identity: 'local-pty:box',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    defaultTarget: 'box',
  });

  expect(ctx.spawns.resolveSpawnTarget(undefined)).toBe('box');
});

test('it refuses a spawn that names no target when the config gives no default', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'box',
        identity: 'local-pty:box',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    defaultTarget: null,
  });

  expect(() => ctx.spawns.resolveSpawnTarget(undefined)).toThrow(
    expect.objectContaining({ code: 'target_config_invalid' }),
  );
});

test('it refuses a spawn to a target the config does not hold', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    defaultTarget: 'local',
  });

  expect(() => ctx.spawns.resolveSpawnTarget('elsewhere')).toThrow(
    expect.objectContaining({ code: 'unknown_target' }),
  );
});

test('it refuses a workspace on a target that cannot transfer an archive', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({
          kind: 'local-pty',
          capabilities: { transfer: false },
        }),
      }),
    ],
    defaultTarget: 'local',
  });

  expect(() => {
    ctx.spawns.requireWorkspaceTarget('local');
  }).toThrow(expect.objectContaining({ code: 'unsupported_operation' }));
});

test('it lands a spawn under a sub-session under the parent of that sub-session', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    defaultTarget: 'local',
  });

  const lead = await ctx.spawns.spawnSession(
    () => ({
      cwd: ctx.dir,
      name: 'lead',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: null,
      overrides: {},
      target: 'local',
      workspace: null,
      scope: null,
      autoDir: false,
    }),
    null,
    null,
  );

  const helper = await ctx.spawns.spawnSession(
    () => ({
      cwd: ctx.dir,
      name: 'helper',
      prompt: '',
      cols: 80,
      rows: 24,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: toSessionID(lead.session.id),
      overrides: {},
      target: 'local',
      workspace: null,
      scope: null,
      autoDir: false,
    }),
    null,
    null,
  );

  expect(ctx.spawns.resolveSpawnParent(toSessionID(helper.session.id))).toBe(
    toSessionID(lead.session.id),
  );
});

test('it answers missing for a spawn under a session the daemon does not hold', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    defaultTarget: 'local',
  });

  expect(ctx.spawns.resolveSpawnParent(toSessionID('s-gone'))).toBe('missing');
});

test('it lands a git workspace under the root its target configures over the global root', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    defaultTarget: 'local',
    workspaceRoots: { root: '/srv/all', targetRoots: new Map([['local', '/srv/local']]) },
  });

  const dir = ctx.spawns.buildDefaultWorkspaceDir('local', {
    kind: 'git',
    url: 'https://example.com/team/widgets.git',
    ref: 'main',
  });

  expect(dir).toBe('/srv/local/widgets-main');
});

test('it lands a git workspace under the daemon home when no root applies', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    defaultTarget: 'local',
  });

  const dir = ctx.spawns.buildDefaultWorkspaceDir('local', {
    kind: 'git',
    url: 'https://example.com/team/widgets.git',
  });

  expect(dir).toBe('/home/wrangler/.local/share/atc/workspaces/widgets');
});

test('it clones a workspace on the daemon side for a remote target that does not clone on its host', async () => {
  const git = await createGitFixture({ prefix: 'atc-spawn-service-git-' });

  const provider = buildStubLocalProvider({ kind: 'cloud', remote: true, cloneOnTarget: false });

  const ctx = await setupTest({
    targets: [buildMockExecutionTarget({ id: 'far', identity: 'cloud:test', provider })],
    defaultTarget: 'far',
    gitTransports: ['file'],
  });

  const dir = join(ctx.dir, 'ws');

  await ctx.spawns.spawnSession(
    () => ({
      cwd: dir,
      name: 'builder',
      prompt: '',
      cols: 100,
      rows: 30,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: null,
      overrides: {},
      target: 'far',
      workspace: { kind: 'git', url: git.upstream, ref: 'main' },
      scope: null,
      autoDir: false,
    }),
    null,
    null,
  );

  expect(provider.transfers).toPartiallyContain({ dir });

  expect(provider.commands).toSatisfyAll(
    (command: CommandSpec) => !command.argv.join(' ').includes('clone'),
  );
});

test('it clones a workspace inside the host for a remote target that clones on its host', async () => {
  const git = await createGitFixture({ prefix: 'atc-spawn-service-git-' });

  const provider = buildStubLocalProvider({ kind: 'cloud', remote: true, cloneOnTarget: true });

  const ctx = await setupTest({
    targets: [buildMockExecutionTarget({ id: 'far', identity: 'cloud:test', provider })],
    defaultTarget: 'far',
    gitTransports: ['file'],
  });

  const dir = join(ctx.dir, 'ws');

  await ctx.spawns.spawnSession(
    () => ({
      cwd: dir,
      name: 'builder',
      prompt: '',
      cols: 100,
      rows: 30,
      resume: false,
      namedBy: 'user',
      agent: 'claude',
      parent: null,
      overrides: {},
      target: 'far',
      workspace: { kind: 'git', url: git.upstream, ref: 'main' },
      scope: null,
      autoDir: false,
    }),
    null,
    null,
  );

  expect(provider.transfers).not.toPartiallyContain({ dir });

  expect(provider.commands).toSatisfyAny((command: CommandSpec) =>
    command.argv.join(' ').includes('clone'),
  );
});

test.each([
  ['true', { hostGitIdentity: true }, 'Example Builder <builder@example.com>'],
  ['false', { hostGitIdentity: false }, ' <>'],
  ['absent', {}, ' <>'],
])(
  'it writes the git identity a remote checkout takes when the identity flag is %s',
  async (_label, flags, expected) => {
    const git = await createGitFixture({ prefix: 'atc-spawn-service-git-' });

    const gitConfig = join(git.dir, 'daemon.gitconfig');

    writeFileSync(gitConfig, '[user]\n\tname = Example Builder\n\temail = builder@example.com\n');
    updateEnv('GIT_CONFIG_GLOBAL', gitConfig);
    updateEnv('GIT_CONFIG_NOSYSTEM', '1');

    const provider = buildStubLocalProvider({
      kind: 'cloud',
      remote: true,
      cloneOnTarget: false,
      ...flags,
    });

    const ctx = await setupTest({
      targets: [buildMockExecutionTarget({ id: 'far', identity: 'cloud:test', provider })],
      defaultTarget: 'far',
      gitTransports: ['file'],
    });

    const dir = join(ctx.dir, 'ws');

    await ctx.spawns.spawnSession(
      () => ({
        cwd: dir,
        name: 'builder',
        prompt: '',
        cols: 100,
        rows: 30,
        resume: false,
        namedBy: 'user',
        agent: 'claude',
        parent: null,
        overrides: {},
        target: 'far',
        workspace: { kind: 'git', url: git.upstream, ref: 'main' },
        scope: null,
        autoDir: false,
      }),
      null,
      null,
    );

    // the checkout's own config file, read by path, so no git variable in
    // this process's environment picks another repository
    const checkoutConfig = join(dir, '.git', 'config');

    const name = await $`git config --file ${checkoutConfig} --get user.name`.nothrow().text();
    const email = await $`git config --file ${checkoutConfig} --get user.email`.nothrow().text();

    expect(`${name.trim()} <${email.trim()}>`).toBe(expected);
  },
);
