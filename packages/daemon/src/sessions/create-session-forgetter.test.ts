import { expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DaemonError } from '@atc/protocol/wire';
import { createStateStore } from '@atc/store';
import {
  buildStubClock,
  buildStubLog,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createConfirmTokens } from './create-confirm-tokens';
import { createForgetCleanup } from './create-forget-cleanup';
import { createSessionForgetter } from './create-session-forgetter';
import { createSessionManager } from './create-session-manager';
import { createSessionRuntime } from './create-session-runtime';
import type { SessionRuntime } from './create-session-runtime';

interface SetupTestConfig {
  // Whether the target's provider can destroy a session's host.
  readonly destroy: boolean;

  // Whether a forget removes what atc kept for the session; on when absent.
  readonly cleanupEnabled?: boolean;
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

  const stopMessageBridge = mock<(id: SessionID) => Promise<void>>(() => Promise.resolve());

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
    events: {
      stopMessageBridge,
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
  const log = buildStubLog();

  manager.log = log.log;

  const stateDir = join(temporaryDirectory.path, 'state');

  const forgetter = createSessionForgetter({
    manager,
    findRuntime: (id) => runtimes.get(id),
    tokens: createConfirmTokens({ now: () => clock.now(), lifetimeMs: 60_000 }),
    cleanup: createForgetCleanup({
      log: log.log,
      stateDir,
      removeDir: (directory) => rm(directory, { recursive: true, force: true }),
      settings: { enabled: config.cleanupEnabled !== false },
    }),
  });

  return {
    directory: temporaryDirectory.path,
    stateDir,
    log,
    provider,
    manager,
    runtimes,
    stopMessageBridge,
    forgetter,
  };
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

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'none' },
  });

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

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: true,
    workspace: { outcome: 'none' },
  });

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

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'none' },
  });
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

test('it removes the state folder of a session it forgets', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(join(folder, 'scratch'), { recursive: true });
  writeFileSync(join(folder, 'scratch', 'draft.md'), '# plan\n');

  await ctx.forgetter.killSession(session.id, false);
  await ctx.forgetter.forgetSession(session.id, undefined, { pinned: false, live: false }, null);

  expect(existsSync(folder)).toBeFalse();
});

test('it keeps the state folder of a forgotten session when cleanup is off', async () => {
  const ctx = await setupTest({ destroy: false, cleanupEnabled: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(join(folder, 'scratch'), { recursive: true });

  await ctx.forgetter.killSession(session.id, false);

  const forgotten = await ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'none' },
  });

  expect(existsSync(join(folder, 'scratch'))).toBeTrue();
});

test('it removes the state folder of an exited session that a second kill forgets', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(join(folder, 'codex'), { recursive: true });

  await ctx.forgetter.killSession(session.id, false);

  const outcome = await ctx.forgetter.killSession(session.id, false);

  expect(outcome).toBe('removed');
  expect(existsSync(folder)).toBeFalse();
});

test('it removes the state folder of each sub-session the forget takes with it', async () => {
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

  const folder = join(ctx.stateDir, 'sessions', child.id);

  mkdirSync(join(folder, 'scratch'), { recursive: true });

  await ctx.forgetter.killSession(parent.id, false);
  await ctx.forgetter.forgetSession(parent.id, undefined, { pinned: false, live: false }, null);

  expect(ctx.manager.sessions).toBeEmpty();
  expect(existsSync(folder)).toBeFalse();
});

test('it keeps the state folder of a pinned sub-session that the forget leaves listed', async () => {
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

  child.pinned = true;

  const folder = join(ctx.stateDir, 'sessions', child.id);

  mkdirSync(join(folder, 'scratch'), { recursive: true });

  await ctx.forgetter.killSession(parent.id, false);
  await ctx.forgetter.forgetSession(parent.id, undefined, { pinned: false, live: false }, null);

  expect(ctx.manager.sessions.map((session) => session.id)).toStrictEqual([child.id]);
  expect(existsSync(join(folder, 'scratch'))).toBeTrue();
});

test('it logs a state folder it cannot remove and still forgets the session', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  mkdirSync(ctx.stateDir, { recursive: true });

  // a file where the sessions folder belongs makes the removal fail with ENOTDIR
  writeFileSync(join(ctx.stateDir, 'sessions'), 'not a folder');

  await ctx.forgetter.killSession(session.id, false);

  const forgotten = await ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'none' },
  });

  expect(ctx.log.lines).toContain(
    `atc: left ${join(ctx.stateDir, 'sessions', session.id)} after session ${session.id} was forgotten, since removing it failed: ENOTDIR: not a directory, rm '${join(ctx.stateDir, 'sessions', session.id)}'`,
  );
});

test('it keeps the state folder of a session whose killed process atc never sees exit, even after a forced kill', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const folder = join(ctx.stateDir, 'sessions', session.id);
  const [harness] = ctx.provider.harnesses;

  invariant(harness !== undefined);
  mkdirSync(join(folder, 'scratch'), { recursive: true });

  // a detached harness reports no exit, as a process atc lost track of
  harness.detach();

  ctx.manager.failedSpawnExitWaitMs = 1;

  await ctx.forgetter.killSession(session.id, false);
  await ctx.forgetter.forgetSession(session.id, undefined, { pinned: false, live: false }, null);

  expect(existsSync(join(folder, 'scratch'))).toBeTrue();
});

test('it keeps the state folder of a session whose headless turn ran when the forget began', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const folder = join(ctx.stateDir, 'sessions', session.id);
  const runtime = ctx.runtimes.get(session.id);

  invariant(runtime !== undefined);
  mkdirSync(join(folder, 'scratch'), { recursive: true });

  runtime.headlessRun = { stop: () => {} };

  await ctx.forgetter.forgetSession(session.id, undefined, { pinned: false, live: false }, null);

  expect(existsSync(join(folder, 'scratch'))).toBeTrue();
});

test('it keeps the state folder of a session whose headless turn a stop aborted before the forget', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const folder = join(ctx.stateDir, 'sessions', session.id);
  const runtime = ctx.runtimes.get(session.id);

  invariant(runtime !== undefined);
  mkdirSync(join(folder, 'scratch'), { recursive: true });

  runtime.headlessRun = { stop: () => {} };

  runtime.stopHeadlessRun();

  await ctx.forgetter.forgetSession(session.id, undefined, { pinned: false, live: false }, null);

  expect(existsSync(join(folder, 'scratch'))).toBeTrue();
});

test('it removes the state folder of a killed session only once its harness exits late', async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const folder = join(ctx.stateDir, 'sessions', session.id);
  const [harness] = ctx.provider.harnesses;

  invariant(harness !== undefined);
  mkdirSync(folder, { recursive: true });

  harness.holdExit();

  const forgetting = ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  await waitFor(() => {
    expect(harness.hasExitWaiters()).toBeTrue();
  });

  const keptWhileRunning = existsSync(folder);

  harness.emitExit({ exitCode: 143 });

  await forgetting;

  expect(keptWhileRunning).toBeTrue();
  expect(existsSync(folder)).toBeFalse();
});

test("it removes a session's state folder only once the stop of its message bridge resolves", async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(folder, { recursive: true });

  const bridgeStop = Promise.withResolvers<undefined>();

  ctx.stopMessageBridge.mockImplementation(() => bridgeStop.promise);

  const forgetting = ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  await waitFor(() => {
    expect(ctx.stopMessageBridge).toHaveBeenCalledWith(session.id);
  });

  const keptWhileStopping = existsSync(folder);

  bridgeStop.resolve(undefined);

  await forgetting;

  expect(keptWhileStopping).toBeTrue();
  expect(existsSync(folder)).toBeFalse();
});

test("it leaves a session's state folder when the stop of its message bridge fails", async () => {
  const ctx = await setupTest({ destroy: false });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(folder, { recursive: true });

  ctx.stopMessageBridge.mockImplementation(() =>
    Promise.reject(new Error('the app server did not stop')),
  );

  await ctx.forgetter.forgetSession(session.id, undefined, { pinned: false, live: false }, null);

  expect(existsSync(folder)).toBeTrue();
});
