import { expect, mock, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '@atc/core';
import type { AgentAdapter, SpawnPlan } from '@atc/plugin-api';
import { createStateStore } from '@atc/store';
import { createMigratedStateDB, registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import { createAuthSetup } from '../auth/create-auth-setup';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { createSessionFleetWriter } from '../fleet/create-session-fleet-writer';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubGuestFilesProvider } from '../testing/build-stub-guest-files-provider';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createHostDirClaims } from './create-host-dir-claims';
import { createSessionAdopter } from './create-session-adopter';
import { createSessionHarnesses } from './create-session-harnesses';
import { createSessionKiller } from './create-session-killer';
import { createSessionRegistry } from './create-session-registry';
import { createSpawnRollback } from './create-spawn-rollback';
import type { SessionCallbacks } from './session-callbacks';

// The agents and execution targets a test runs its sessions under.
interface SetupTestConfig {
  readonly adapters: readonly AgentAdapter[];
  readonly targets: readonly ExecutionTarget[];
}

// The session modules wired as the session manager wires them, over a real
// state store, with the test's agents and targets and a recorder for each
// callback.
async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-session-adopter-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  // An agent takes its messages through no bridge unless a test says so.
  const startMessageBridge = mock<SessionCallbacks['startMessageBridge']>(() =>
    Promise.resolve(null),
  );

  const stopMessageBridge = mock<SessionCallbacks['stopMessageBridge']>(() => Promise.resolve());

  const callbacks: SessionCallbacks = {
    onOutput: mock<() => void>(),
    onChange: mock<() => void>(),
    onBoot: mock<() => void>(),
    onRelay: mock<() => void>(),
    onEvent: mock<() => void>(),
    onProcessEnded: mock<() => void>(),
    startMessageBridge,
    stopMessageBridge,
    log: mock<() => void>(),
    now: () => 0,
    getClock: () => systemClock,
    getReporterSocketPath: () => join(temporaryDirectory.path, 'reporter.sock'),
    findAuthBinder: () => null,
    findRecords: () => null,
  };

  const registry = createSessionRegistry({
    fallback: null,
    adapters: config.adapters,
    targets: config.targets,
    targetErrors: [],
    callbacks,
  });

  const fleet = createSessionFleetWriter({
    registry,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    callbacks,
  });

  const claims = createHostDirClaims({ registry });
  const restarts = { stopRestart: (id: SessionID) => adopter.stopRestart(id) };
  const killer = createSessionKiller({ registry, fleet, callbacks, restarts });
  const harnesses = createSessionHarnesses({ registry, fleet, killer, callbacks });
  const rollback = createSpawnRollback({ registry, fleet, claims, harnesses, callbacks });
  const auth = createAuthSetup({ registry, fleet, claims, harnesses, rollback, store, callbacks });
  const adopter = createSessionAdopter({ registry, fleet, harnesses, rollback, auth, callbacks });

  return {
    directory: temporaryDirectory.path,
    callbacks,
    startMessageBridge,
    stopMessageBridge,
    registry,
    adopter,
  };
}

test('it never revives a restored entry whose agent id is unregistered as another agent', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-z-1'),
    name: 'glm work',
    cwd: ctx.directory,
    kind: 'headless',
    state: 'running',
    lastMsg: "no adapter for 'zai'",
    agentSessionID: toAgentSessionID('z-1'),
    agent: 'zai',
    target: 'local',
    targetIdentity: 'local-pty:test',
  });

  ctx.registry.sessions.push(session);
  ctx.registry.unrestored.add(session.id);

  const adopted = await ctx.adopter.adoptTerminal(session.id, 80, 24);

  expect(adopted).toBeNull();
});

test('it starts a harness that resumes the agent session of a session without a terminal', async () => {
  const adapter = buildStubHarnessAdapter();
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [adapter],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: ctx.directory,
    kind: 'headless',
    state: 'running',
    lastMsg: 'waiting to restore',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
    target: 'local',
    targetIdentity: 'local-pty:test',
  });

  ctx.registry.sessions.push(session);
  ctx.registry.unrestored.add(session.id);

  const adopted = await ctx.adopter.adoptTerminal(session.id, 100, 30);

  expect(adapter.spawns).toStrictEqual([
    { opts: { prompt: '', resume: toAgentSessionID('c-1') }, session: toSessionID('s-c-1') },
  ]);

  expect(provider.harnesses).toHaveLength(1);

  expect(provider.harnesses[0]?.spec).toMatchObject({
    session: toSessionID('s-c-1'),
    host: toSessionID('s-c-1'),
    bin: 'stub-harness',
    args: [],
    cwd: ctx.directory,
    env: { ATC_SESSION_ID: 's-c-1' },
    withheldEnv: [],
    cols: 100,
    rows: 30,
  });

  expect(provider.harnesses[0]?.spec.env).toContainAllKeys(['ATC_SESSION_ID', 'ATC_SOCKET']);
  expect(provider.harnesses[0]?.spec.env['ATC_SOCKET']).toBe(join(ctx.directory, 'reporter.sock'));
  expect(provider.harnesses[0]?.spec.onRelay).toBeFunction();
  expect(adopted).toMatchObject({ kind: 'pty', state: 'running', lastMsg: 'revived' });
  expect(adopted?.pty).toBe(provider.harnesses[0]);
  expect(ctx.callbacks.onBoot).toHaveBeenCalledExactlyOnceWith(session, 100, 30);
});

test('it keeps the agent home the remote host resolves for the revived harness on the session', async () => {
  const adapter: AgentAdapter = {
    ...buildStubHarnessAdapter(),
    agentHomeLocation: { env: 'GROK_HOME', folder: '.grok' },
  };

  const provider = buildStubGuestFilesProvider({
    guestDirectory: '/guest/atc',
    hostDirectory: '/nonexistent',
  });

  const ctx = await setupTest({
    adapters: [adapter],
    targets: [buildMockExecutionTarget({ id: 'box', identity: 'remote:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-g-1'),
    cwd: '/root/work',
    kind: 'headless',
    state: 'running',
    lastMsg: 'waiting to restore',
    agentSessionID: toAgentSessionID('g-1'),
    agent: 'claude',
    target: 'box',
    targetIdentity: 'remote:test',
    agentHome: '/guest/atc/old-home/.grok',
  });

  ctx.registry.sessions.push(session);
  ctx.registry.unrestored.add(session.id);

  const adopted = await ctx.adopter.adoptTerminal(session.id, 100, 30);

  expect(adopted?.agentHome).toBe('/guest/atc/home/.grok');
});

test('it starts nothing for a session without an agent session id', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: ctx.directory,
    kind: 'headless',
    state: 'running',
    agent: 'claude',
    target: 'local',
    targetIdentity: 'local-pty:test',
  });

  ctx.registry.sessions.push(session);

  const adopted = await ctx.adopter.adoptTerminal(session.id, 80, 24);

  expect(adopted).toBeNull();
  expect(provider.harnesses).toStrictEqual([]);
});

test('it starts nothing for a session that already has a terminal', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const running = buildStubMemoryProvider().spawnHarness({
    session: toSessionID('s-c-1'),
    host: toSessionID('s-c-1'),
    bin: 'stub-harness',
    args: [],
    cwd: '/work/proj',
    env: {},
    withheldEnv: [],
    cols: 80,
    rows: 24,
  });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: ctx.directory,
    pty: running,
    state: 'running',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
    target: 'local',
    targetIdentity: 'local-pty:test',
  });

  ctx.registry.sessions.push(session);

  const adopted = await ctx.adopter.adoptTerminal(session.id, 80, 24);

  expect(adopted).toBeNull();
  expect(provider.harnesses).toStrictEqual([]);
});

test('it starts nothing when the caller withdraws the revive', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: ctx.directory,
    kind: 'headless',
    state: 'running',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
    target: 'local',
    targetIdentity: 'local-pty:test',
  });

  ctx.registry.sessions.push(session);

  const adopted = await ctx.adopter.adoptTerminal(session.id, 80, 24, () => false);

  expect(adopted).toBeNull();
  expect(provider.harnesses).toStrictEqual([]);
});

test('it starts one bridge and one terminal when a second revive lands while the bridge starts', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: ctx.directory,
    kind: 'headless',
    state: 'running',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
    target: 'local',
    targetIdentity: 'local-pty:test',
  });

  ctx.registry.sessions.push(session);
  ctx.registry.unrestored.add(session.id);

  const bridge = Promise.withResolvers<SpawnPlan | null>();

  ctx.startMessageBridge.mockImplementationOnce(() => bridge.promise);

  const first = ctx.adopter.adoptTerminal(session.id, 80, 24);

  await waitFor(() => {
    expect(ctx.startMessageBridge).toHaveBeenCalledOnce();
  });

  const second = await ctx.adopter.adoptTerminal(session.id, 80, 24);

  bridge.resolve({ bin: 'stub-harness', args: ['--remote', 'unix://codex.sock'] });

  const adopted = await first;

  expect(adopted).toBe(session);
  expect(second).toBeNull();
  expect(ctx.startMessageBridge).toHaveBeenCalledOnce();
  expect(ctx.stopMessageBridge).not.toHaveBeenCalled();
  expect(provider.harnesses).toHaveLength(1);
});

test('it stops the message bridge when the revived terminal fails to start', async () => {
  const provider = buildStubMemoryProvider({
    kind: 'local-pty',
    onSpawn: () => {
      throw new Error('harness refused');
    },
  });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: ctx.directory,
    kind: 'headless',
    state: 'running',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
    target: 'local',
    targetIdentity: 'local-pty:test',
  });

  ctx.registry.sessions.push(session);
  ctx.registry.unrestored.add(session.id);

  ctx.startMessageBridge.mockImplementationOnce(() =>
    Promise.resolve({ bin: 'stub-harness', args: ['--remote', 'unix://codex.sock'] }),
  );

  const adopted = ctx.adopter.adoptTerminal(session.id, 80, 24);

  expect(adopted).rejects.toThrowWithMessage(Error, 'harness refused');
  expect(ctx.stopMessageBridge).toHaveBeenCalledExactlyOnceWith(toSessionID('s-c-1'));
});

test('it revives a session with the plugin folders its spawn kept', async () => {
  const adapter = buildStubHarnessAdapter();
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [adapter],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  mkdirSync(join(ctx.directory, 'band'));

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: ctx.directory,
    kind: 'headless',
    state: 'running',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
    target: 'local',
    targetIdentity: 'local-pty:test',
    pluginDirs: [join(ctx.directory, 'band')],
  });

  ctx.registry.sessions.push(session);
  ctx.registry.unrestored.add(session.id);

  await ctx.adopter.adoptTerminal(session.id, 80, 24);

  expect(adapter.spawns).toStrictEqual([
    {
      opts: {
        prompt: '',
        resume: toAgentSessionID('c-1'),
        pluginDirs: [join(ctx.directory, 'band')],
      },
      session: toSessionID('s-c-1'),
    },
  ]);
});

test("it refuses to revive a session whose agent's configured plugin folder is gone, starting nothing", async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'stub-harness',
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
          },
          pluginDirs: ['/nonexistent/plugins/shared'],
        },
      },
    ],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: ctx.directory,
    kind: 'headless',
    state: 'running',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
    target: 'local',
    targetIdentity: 'local-pty:test',
  });

  ctx.registry.sessions.push(session);
  ctx.registry.unrestored.add(session.id);

  const adopted = ctx.adopter.adoptTerminal(session.id, 80, 24);

  await adopted.catch(() => null);

  expect(adopted).rejects.toMatchObject({
    code: 'bad_args',
    message: "plugin folder '/nonexistent/plugins/shared' does not exist",
  });

  expect(provider.harnesses).toStrictEqual([]);
});

test("it refuses to revive a session on a remote target once its agent's config sets plugin folders, starting nothing", async () => {
  const provider = buildStubMemoryProvider({ kind: 'imp-like', remote: true });

  const ctx = await setupTest({
    adapters: [
      {
        ...buildStubHarnessAdapter(),
        profile: {
          label: 'Claude',
          kind: 'claude',
          bin: 'stub-harness',
          models: null,
          spawnOptions: {
            model: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
            effort: {
              supported: false,
              values: null,
              examples: [],
              default: null,
              backendEffect: null,
              note: null,
            },
          },
          pluginDirs: ['/opt/plugins/shared'],
        },
      },
    ],
    targets: [buildMockExecutionTarget({ id: 'box', identity: 'imp-like:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: '/work',
    kind: 'headless',
    state: 'running',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
    target: 'box',
    targetIdentity: 'imp-like:test',
  });

  ctx.registry.sessions.push(session);
  ctx.registry.unrestored.add(session.id);

  const adopted = ctx.adopter.adoptTerminal(session.id, 80, 24);

  await adopted.catch(() => null);

  expect(adopted).rejects.toMatchObject({
    code: 'unsupported',
    message:
      "target 'box' runs the agent on another machine, so it takes no pluginDirs; the agent's config or the spawn sets them",
  });

  expect(provider.harnesses).toStrictEqual([]);
});
