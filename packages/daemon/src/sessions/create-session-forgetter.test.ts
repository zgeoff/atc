import { expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonError } from '@atc/protocol/wire';
import { createStateStore } from '@atc/store';
import {
  buildStubClock,
  buildStubLog,
  createGitFixture,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import invariant from 'tiny-invariant';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubLocalProvider } from '../testing/build-stub-local-provider';
import { createConfirmTokens } from './create-confirm-tokens';
import { createForgetCleanup } from './create-forget-cleanup';
import { REMOVE_DIR_SCRIPT } from './create-host-dir-claims';
import { createSessionForgetter } from './create-session-forgetter';
import { createSessionManager } from './create-session-manager';
import { createSessionRuntime } from './create-session-runtime';
import type { SessionRuntime } from './create-session-runtime';
import { WORKSPACE_CHECK_SCRIPT } from './run-workspace-check';

interface SetupTestConfig {
  // Whether the target's provider can destroy a session's host.
  readonly destroy: boolean;

  // Whether the target's provider can put a host to sleep, which gives each
  // sub-session its parent's host; it can when it can destroy one.
  readonly suspend?: boolean;

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

  const provider = buildStubLocalProvider({
    capabilities: { suspend: config.suspend ?? config.destroy, destroy: config.destroy },
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
  const log = buildStubLog();

  manager.log = log.log;

  const stateDir = join(temporaryDirectory.path, 'state');

  const forgetter = createSessionForgetter({
    manager,
    findRuntime: (id) => runtimes.get(id),
    tokens: createConfirmTokens({ now: () => clock.now(), lifetimeMs: 60_000 }),
    cleanup: createForgetCleanup({
      manager,
      store,
      stateDir,
      settings: { enabled: config.cleanupEnabled !== false, check: 'unpushed' },
    }),
  });

  return {
    directory: temporaryDirectory.path,
    stateDir,
    store,
    log,
    provider,
    manager,
    runtimes,
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

test('it reports no workspace and runs no check when the forget destroys the host', async () => {
  const ctx = await setupTest({ destroy: true });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: ctx.directory,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    {
      phase: 'ready',
      repoURL: 'https://example.com/shop.git',
      sha: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe',
      materializedAt: 2000,
    },
    2000,
  );

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

  expect(
    ctx.provider.commands.filter((spec) => spec.argv.includes(WORKSPACE_CHECK_SCRIPT)),
  ).toBeEmpty();

  expect(existsSync(ctx.directory)).toBeTrue();
});

test("it checks and removes the workspace of a sub-session on its parent's host through the provider", async () => {
  const ctx = await setupTest({ destroy: false, suspend: true });
  const git = await createGitFixture({ prefix: 'atc-forget-shared-host-' });

  const parent = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'lead',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const child = await ctx.manager.spawn({
    cwd: git.work,
    name: 'helper',
    prompt: '',
    cols: 80,
    rows: 24,
    parent: parent.id,
  });

  await ctx.store.createMaterialization(
    {
      sessionID: child.id,
      target: 'local',
      directory: git.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    child.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: git.sha, materializedAt: 2000 },
    2000,
  );

  const path = realpathSync(git.work);

  await ctx.forgetter.killSession(child.id, false);

  const forgotten = await ctx.forgetter.forgetSession(
    child.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'removed', path, found: [] },
  });

  expect(
    ctx.provider.commands
      .filter(
        (spec) =>
          spec.argv.includes(WORKSPACE_CHECK_SCRIPT) || spec.argv.includes(REMOVE_DIR_SCRIPT),
      )
      .map((spec) => ({
        step: spec.argv.includes(REMOVE_DIR_SCRIPT) ? 'removal' : 'check',
        host: spec.host,
      })),
  ).toStrictEqual([
    { step: 'check', host: parent.id },
    { step: 'removal', host: parent.id },
  ]);

  expect(existsSync(git.work)).toBeFalse();
});

test('it keeps the workspace of a session whose killed process atc never sees exit, even after a forced kill', async () => {
  const ctx = await setupTest({ destroy: false });
  const git = await createGitFixture({ prefix: 'atc-forget-unended-' });

  const session = await ctx.manager.spawn({
    cwd: git.work,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: git.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: git.sha, materializedAt: 2000 },
    2000,
  );

  const [harness] = ctx.provider.harnesses;

  invariant(harness !== undefined);

  // a detached harness reports no exit, as a process atc lost track of
  harness.detach();

  ctx.manager.failedSpawnExitWaitMs = 1;

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
    workspace: {
      outcome: 'kept',
      path: git.work,
      reasons: ["unchecked: atc could not confirm that the session's process exited"],
    },
  });

  expect(existsSync(git.work)).toBeTrue();
});

test('it keeps the workspace of a session whose headless turn ran when the forget began', async () => {
  const ctx = await setupTest({ destroy: false });
  const git = await createGitFixture({ prefix: 'atc-forget-headless-' });

  const session = await ctx.manager.spawn({
    cwd: git.work,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: git.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: git.sha, materializedAt: 2000 },
    2000,
  );

  const runtime = ctx.runtimes.get(session.id);

  invariant(runtime !== undefined);

  runtime.headlessRun = { stop: () => {} };

  const forgotten = await ctx.forgetter.forgetSession(
    session.id,
    undefined,
    { pinned: false, live: false },
    null,
  );

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: {
      outcome: 'kept',
      path: git.work,
      reasons: ["unchecked: atc could not confirm that the session's process exited"],
    },
  });

  expect(existsSync(git.work)).toBeTrue();
});
