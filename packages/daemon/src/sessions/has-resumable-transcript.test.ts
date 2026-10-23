import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AgentAdapter } from '@atc/plugin-api';
import { createStateStore } from '@atc/store';
import {
  buildStubLog,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createSessionManager } from './create-session-manager';
import { hasResumableTranscript } from './has-resumable-transcript';

interface SetupTestConfig {
  // The one agent the sessions run.
  readonly adapter: AgentAdapter;

  // Whether the target's host runs away from the daemon's machine.
  readonly remote: boolean;
}

// A session manager on one `local` target over the in-memory provider and
// a real state store.
async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-resumable-transcript-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [config.adapter],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({
          kind: 'local-pty',
          remote: config.remote,
          guest: { directory: '/srv/orchard-guest', atc: null },
        }),
      }),
    ],
  });

  registerTestCleanup(() => {
    manager.detachAll();
  });

  // A remote spawn logs its step times.
  manager.log = buildStubLog().log;

  return { directory: temporaryDirectory.path, manager };
}

test('it asks the agent whether it can resume the conversation of a local session', async () => {
  const ctx = await setupTest({
    adapter: {
      ...buildStubHarnessAdapter(),
      canResume: (opts) => opts.agentSessionID === 'a-1',
    },
    remote: false,
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  session.agentSessionID = toAgentSessionID('a-1');

  expect(hasResumableTranscript(ctx.manager, session.id)).toBeTrue();
});

test('it finds a local session resumable only when its agent says so', async () => {
  const ctx = await setupTest({
    adapter: { ...buildStubHarnessAdapter(), canResume: () => false },
    remote: false,
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  session.agentSessionID = toAgentSessionID('a-1');

  expect(hasResumableTranscript(ctx.manager, session.id)).toBeFalse();
});

test('it finds a remote session resumable once it holds an agent session id', async () => {
  const ctx = await setupTest({
    adapter: { ...buildStubHarnessAdapter(), canResume: () => false },
    remote: true,
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  session.agentSessionID = toAgentSessionID('a-1');

  expect(hasResumableTranscript(ctx.manager, session.id)).toBeTrue();
});

test('it finds a remote session without an agent session id not resumable', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter(), remote: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  expect(hasResumableTranscript(ctx.manager, session.id)).toBeFalse();
});

test('it finds a session the manager does not hold not resumable', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter(), remote: false });

  expect(hasResumableTranscript(ctx.manager, toSessionID('s-gone'))).toBeFalse();
});
