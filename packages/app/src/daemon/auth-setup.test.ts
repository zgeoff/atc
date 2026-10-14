import { expect, mock, test } from 'bun:test';
import { createStepTimer } from '@atc/core/create-step-timer';
import { toDaemonID } from '@atc/core/to-daemon-id';
import { toSessionID } from '@atc/core/to-session-id';
import type { AgentAdapter } from '@atc/plugin-api/agent-adapter';
import { buildMockAgentAdapter } from '@atc/test-utils/build-mock-agent-adapter';
import { runShellcheck } from '@atc/test-utils/run-shellcheck';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { AuthSetup, READ_PROJECT_SETTINGS_SCRIPT } from './auth-setup';
import type { ExecutionTarget } from './build-execution-targets';
import { SessionRegistry } from './session-registry';
import { buildStubHarnessAdapter } from './testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from './testing/build-stub-memory-provider';

interface SetupConfig {
  readonly adapters: readonly AgentAdapter[];
  readonly targets: readonly ExecutionTarget[];
}

function setupTest(config: SetupConfig) {
  const registry = new SessionRegistry({
    fallback: null,
    adapters: config.adapters,
    targets: config.targets,
    targetErrors: [],
    callbacks: { onEvent: mock() },
  });

  const auth = new AuthSetup({
    registry,
    fleet: { emitChange: mock() },
    claims: { resolveHostHome: mock() },
    harnesses: { authRevisions: new Map(), isAuthOutdated: mock(), isHostIdle: mock() },
    rollback: { destroyFailedSpawnHost: mock() },

    // Every host the setup readies is stamped with the daemon's id.
    store: { daemonID: toDaemonID('d-1') },
    callbacks: { onEvent: mock(), log: mock(), getAuthBinder: () => null },
  });

  return { registry, auth };
}

test.each([['reads the project settings', READ_PROJECT_SETTINGS_SCRIPT]])(
  'it %s through a script that passes shellcheck',
  async (_label, script) => {
    const result = await runShellcheck(script);

    expect(result).toStrictEqual({ exitCode: 0, findings: [] });
  },
);

test('it passes an agent with no auth selection on any target', () => {
  const ctx = setupTest({
    adapters: [buildStubHarnessAdapter({ id: 'claude' })],
    targets: [buildMockExecutionTarget({ id: 'imp', provider: buildStubMemoryProvider() })],
  });

  expect(() => {
    ctx.auth.requireAgentTarget('claude', 'imp');
  }).not.toThrow();
});

test('it refuses an agent that starts only behind the broker on a target that reaches none', () => {
  const ctx = setupTest({
    adapters: [
      buildMockAgentAdapter({
        id: 'glm',
        findAuthSelection: () => ({
          brokerRequired: true,
          gateway: {
            id: 'glm',
            baseURL: 'https://api.z.ai/api/anthropic',
            auth: { profiles: ['glm'], placeholderEnv: {} },
          },
          profiles: new Map(),
        }),
      }),
    ],
    targets: [buildMockExecutionTarget({ id: 'imp', provider: buildStubMemoryProvider() })],
  });

  expect(() => {
    ctx.auth.requireAgentTarget('glm', 'imp');
  }).toThrow(expect.objectContaining({ code: 'auth_target_unsupported' }));
});

test('it resolves no harness auth for an agent with no auth selection', () => {
  const adapter = buildStubHarnessAdapter({ id: 'claude' });
  const provider = buildStubMemoryProvider();

  const ctx = setupTest({
    adapters: [adapter],
    targets: [buildMockExecutionTarget({ id: 'imp', provider })],
  });

  expect(ctx.auth.resolveHarnessAuth(adapter, provider, 'imp')).toBeNull();
});

test('it readies a local host once and plans the agent spawn there', async () => {
  const adapter = buildStubHarnessAdapter({ id: 'claude' });
  const provider = buildStubMemoryProvider({ remote: false });

  const ctx = setupTest({
    adapters: [adapter],
    targets: [buildMockExecutionTarget({ id: 'local', provider })],
  });

  const setup = await ctx.auth.setupHarnessOnHost(
    adapter,
    provider,
    toSessionID('spawn-1'),
    toSessionID('host-1'),
    'local',
    { prompt: '', resume: false },
    null,
    null,
    false,
    createStepTimer(),
  );

  expect(setup).toStrictEqual({
    plan: { bin: 'stub-harness', args: [], env: {}, admission: null, heldRevision: null },
    attemptID: null,
  });

  expect(provider.prepared).toStrictEqual([
    {
      host: toSessionID('host-1'),
      daemonID: 'd-1',
      isIdle: expect.any(Function),
      timer: expect.anything(),
    },
  ]);
});

test('it readies a remote host and plans the local spawn with no files when the agent plans no guest spawn', async () => {
  const adapter = buildStubHarnessAdapter({ id: 'claude' });
  const provider = buildStubMemoryProvider({ remote: true });

  const ctx = setupTest({
    adapters: [adapter],
    targets: [buildMockExecutionTarget({ id: 'imp', provider })],
  });

  const setup = await ctx.auth.setupHarnessOnHost(
    adapter,
    provider,
    toSessionID('spawn-1'),
    toSessionID('host-1'),
    'imp',
    { prompt: '', resume: false },
    null,
    null,
    false,
    createStepTimer(),
  );

  expect(setup).toStrictEqual({
    plan: { bin: 'stub-harness', args: [], env: {}, admission: null, heldRevision: null },
    attemptID: null,
  });

  expect(provider.prepared).toStrictEqual([
    {
      host: toSessionID('host-1'),
      daemonID: 'd-1',
      installATC: false,
      log: expect.any(Function),
      isIdle: expect.any(Function),
      timer: expect.anything(),
    },
  ]);

  expect(provider.transfers).toStrictEqual([]);
});

test('it refuses to hand out an auth binder when the daemon binds no runtime auth', () => {
  const ctx = setupTest({ adapters: [], targets: [] });

  expect(() => ctx.auth.requireAuthBinder()).toThrow(
    expect.objectContaining({ code: 'unsupported_operation' }),
  );
});

test('it reads no project settings for an agent that plans no settings check', async () => {
  const adapter = buildStubHarnessAdapter({ id: 'claude' });
  const provider = buildStubMemoryProvider({ remote: true });

  const ctx = setupTest({
    adapters: [adapter],
    targets: [buildMockExecutionTarget({ id: 'imp', provider })],
  });

  await ctx.auth.requireProjectSettings(adapter, provider, toSessionID('host-1'), 'imp', '/work');

  expect(provider.commands).toStrictEqual([]);
});
