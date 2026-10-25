import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonError } from '@atc/protocol/wire';
import { createStateStore } from '@atc/store';
import {
  buildStubClock,
  buildStubLog,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createConfirmTokens } from './create-confirm-tokens';
import { createSessionForgetter } from './create-session-forgetter';
import { createSessionManager } from './create-session-manager';
import { createSessionRuntime } from './create-session-runtime';
import type { SessionRuntime } from './create-session-runtime';

interface SetupTestConfig {
  // Whether the target's provider can destroy a session's host.
  readonly destroy: boolean;
}

async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-session-forgetter-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const clock = buildStubClock(1_000_000);

  const runtimes = new Map<SessionID, SessionRuntime>();

  const provider = buildStubMemoryProvider({
    kind: 'local-pty',
    capabilities: { suspend: config.destroy, destroy: config.destroy },
  });

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    events: {
      onEvent: (kind, session) => {
        if (kind === 'added') {
          runtimes.set(session.id, createSessionRuntime());
        }
      },
    },
  });

  registerTestCleanup(() => {
    manager.detachAll();
  });

  // A destroy logs the host it removed.
  manager.log = buildStubLog().log;

  const forgetter = createSessionForgetter({
    manager,
    findRuntime: (id) => runtimes.get(id),
    tokens: createConfirmTokens({ now: () => clock.now(), lifetimeMs: 60_000 }),
  });

  return { directory: temporaryDirectory.path, provider, manager, runtimes, forgetter };
}

test('it forgets a session at once on a target that cannot destroy its host', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  await ctx.forgetter.killSession(session.id, false);

  const forgotten = await ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
  expect(ctx.manager.sessions).toBeEmpty();
});

test('it answers a forget on a host-destroying target with a token and destroys nothing', async () => {
  const ctx = await setupTest({ destroy: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  await ctx.forgetter.killSession(session.id, false);

  const answer = await ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(answer).toMatchObject({ expiresAt: 1_060_000 });
  expect(ctx.provider.destroyed).toBeEmpty();
  expect(ctx.manager.sessions).toHaveLength(1);
});

test('it destroys the host and forgets the session when the forget carries its token', async () => {
  const ctx = await setupTest({ destroy: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  await ctx.forgetter.killSession(session.id, false);

  const answer = await ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  invariant(typeof answer === 'object' && 'confirmToken' in answer);

  const forgotten = await ctx.forgetter.forgetSession(
    session.id,
    answer.confirmToken,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: true });
  expect(ctx.provider.destroyed).toHaveLength(1);
});

test('it refuses a pinned session when the caller asks it to', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  session.pinned = true;

  const forgotten = ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: true, live: false },
    null,
  );

  expect(forgotten).rejects.toThrowWithMessage(DaemonError, /is pinned/u);
});

test('it forgets a sub-session of a pinned session when its parent asks', async () => {
  const ctx = await setupTest({ destroy: false });

  const parent = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'lead',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const child = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'helper',
    prompt: '',
    cols: 80,
    rows: 24,
    parent: parent.id,
  });

  parent.pinned = true;

  await ctx.forgetter.killSession(child.id, false);

  const forgotten = await ctx.forgetter.forgetSession(
    child.id,
    undefined,
    { pinned: true, live: false },
    parent.id,
  );

  expect(forgotten).toStrictEqual({ forgotten: true, destroyed: false });
});

test('it refuses a sub-session of a pinned session that another caller asks to forget', async () => {
  const ctx = await setupTest({ destroy: false });

  const parent = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'lead',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const child = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'helper',
    prompt: '',
    cols: 80,
    rows: 24,
    parent: parent.id,
  });

  parent.pinned = true;

  const forgotten = ctx.forgetter.forgetSession(
    child.id,
    undefined,
    { pinned: true, live: false },
    null,
  );

  expect(forgotten).rejects.toThrowWithMessage(DaemonError, /is pinned/u);
});

test('it refuses a live session when the caller asks it to', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const forgotten = ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: false, live: true },
    null,
  );

  expect(forgotten).rejects.toThrowWithMessage(DaemonError, /is live/u);
});

test('it answers a forget of a session the manager does not hold as missing', async () => {
  const ctx = await setupTest({ destroy: false });

  const forgotten = await ctx.forgetter.forgetSession(
    toSessionID('s-gone'),
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toBe('missing');
});

test('it stops a live session that a kill asks to stop', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const outcome = await ctx.forgetter.killSession(session.id, true);

  expect(outcome).toBe('stopped');
  expect(session.pty).toBeNull();
});

test('it answers a kill of a session the manager does not hold as missing', async () => {
  const ctx = await setupTest({ destroy: false });

  expect(ctx.forgetter.killSession(toSessionID('s-gone'), false)).resolves.toBe('missing');
});

test('it stops the headless run of a session a kill ends', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const runtime = ctx.runtimes.get(session.id);

  invariant(runtime);

  const stop = mock<() => void>();

  runtime.headlessRun = { stop };

  await ctx.forgetter.killSession(session.id, true);

  expect(stop).toHaveBeenCalledOnce();
});
