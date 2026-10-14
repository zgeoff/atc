import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { systemClock } from '@atc/core/system-clock';
import { toAgentSessionID } from '@atc/core/to-agent-session-id';
import { toSessionID } from '@atc/core/to-session-id';
import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';
import { StateStore } from '@atc/store/state-store';
import { createMigratedStateDB } from '@atc/store/testing/create-migrated-state-db';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockSession } from '../test-utils/build-mock-session';
import { AuthSetup } from './auth-setup';
import type { ExecutionTarget } from './build-execution-targets';
import { HostDirClaims } from './host-dir-claims';
import { SessionAdopter } from './session-adopter';
import type { SessionCallbacks } from './session-callbacks';
import { SessionFleetWriter } from './session-fleet-writer';
import { SessionHarnesses } from './session-harnesses';
import { SessionKiller } from './session-killer';
import { SessionRegistry } from './session-registry';
import { SpawnRollback } from './spawn-rollback';
import { buildStubHarnessAdapter } from './testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from './testing/build-stub-memory-provider';

// The agents and execution targets a test runs its sessions under.
interface SetupTestConfig {
  readonly adapters: readonly AgentAdapter[];
  readonly targets: readonly ExecutionTarget[];
}

// The session modules wired as the session manager wires them, over a real
// state store, with the test's agents and targets and a recorder for each
// callback.
async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-session-adopter-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const callbacks: SessionCallbacks = {
    onOutput: mock(),
    onChange: mock(),
    onBoot: mock(),
    onRelay: mock(),
    onEvent: mock(),
    onProcessEnded: mock(),
    log: mock(),
    now: () => 0,
    getClock: () => systemClock,
    getAuthBinder: () => null,
    getRecords: () => null,
  };

  const registry = new SessionRegistry({
    fallback: null,
    adapters: config.adapters,
    targets: config.targets,
    targetErrors: [],
    callbacks,
  });

  const fleet = new SessionFleetWriter({
    registry,
    store,
    statusPath: join(tmp.dir, 'status.json'),
    callbacks,
  });

  const claims = new HostDirClaims({ registry });
  const killer = new SessionKiller({ registry, fleet, callbacks });
  const harnesses = new SessionHarnesses({ registry, fleet, killer, callbacks });
  const rollback = new SpawnRollback({ registry, fleet, claims, harnesses, callbacks });
  const auth = new AuthSetup({ registry, fleet, claims, harnesses, rollback, store, callbacks });
  const adopter = new SessionAdopter({ registry, fleet, harnesses, rollback, auth, callbacks });

  return { dir: tmp.dir, callbacks, registry, adopter };
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
    cwd: ctx.dir,
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
    cwd: ctx.dir,
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

  expect(provider.harnesses[0]?.spec).toStrictEqual({
    session: toSessionID('s-c-1'),
    host: toSessionID('s-c-1'),
    bin: 'stub-harness',
    args: [],
    cwd: ctx.dir,
    env: { ATC_SESSION_ID: 's-c-1', ATC_SOCKET: expect.any(String) },
    withheldEnv: [],
    cols: 100,
    rows: 30,
    onRelay: expect.any(Function),
  });

  expect(adopted).toMatchObject({ kind: 'pty', state: 'running', lastMsg: 'revived' });
  expect(adopted?.pty).toBe(provider.harnesses[0]);
  expect(ctx.callbacks.onBoot).toHaveBeenCalledExactlyOnceWith(session, 100, 30);
});

test('it starts nothing for a session without an agent session id', async () => {
  const provider = buildStubMemoryProvider({ kind: 'local-pty' });

  const ctx = await setupTest({
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const session = buildMockSession({
    id: toSessionID('s-c-1'),
    cwd: ctx.dir,
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
    cwd: ctx.dir,
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
    cwd: ctx.dir,
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
