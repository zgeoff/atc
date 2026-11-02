import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createStateStore } from '@atc/store';
import {
  buildStubLog,
  createGitFixture,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { $ } from 'bun';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubLocalProvider } from '../testing/build-stub-local-provider';
import { createForgetCleanup } from './create-forget-cleanup';
import { createSessionManager } from './create-session-manager';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-forget-cleanup-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const provider = buildStubLocalProvider();

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const log = buildStubLog();

  manager.log = log.log;

  const stateDir = join(temporaryDirectory.path, 'state');

  return {
    store,
    manager,
    provider,
    log,
    stateDir,
    cleanup: createForgetCleanup({
      manager,
      store,
      stateDir,
      removeDir: (directory) => rm(directory, { recursive: true, force: true }),
      settings: { enabled: true, check: 'unpushed' },
    }),
  };
}

test('it removes a pushed workspace and the state folder, and logs the removal', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work });
  const folder = join(ctx.stateDir, 'sessions', session.id);
  const path = realpathSync(git.work);

  mkdirSync(folder, { recursive: true });

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

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({ outcome: 'removed', path, found: [] });
  expect(existsSync(git.work)).toBeFalse();
  expect(existsSync(folder)).toBeFalse();

  expect(ctx.log.lines).toStrictEqual([
    `atc: removed the workspace ${path} of forgotten session ${session.id}`,
  ]);
});

test('it refuses a spawn into the workspace while the check that decides its removal runs', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work });

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

  ctx.provider.holdCommands();

  const removing = ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  await waitFor(() => {
    expect(ctx.provider.hasHeldCommands()).toBeTrue();
  });

  const spawn = ctx.manager.spawn({
    cwd: git.work,
    name: 'late-worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const refusal = await spawn.then(
    () => null,
    (error: unknown) => error,
  );

  ctx.provider.finishCommands();

  await removing;

  expect(refusal).toMatchObject({ code: 'workspace_overlap' });
});

test('it keeps a workspace with an uncommitted change, removes the state folder, and logs why', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work });
  const folder = join(ctx.stateDir, 'sessions', session.id);
  const path = realpathSync(git.work);

  mkdirSync(folder, { recursive: true });
  writeFileSync(join(git.work, 'README.md'), 'hello, unsaved\n');

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

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({
    outcome: 'kept',
    path,
    reasons: ['1 uncommitted or untracked path'],
  });

  expect(existsSync(join(git.work, 'README.md'))).toBeTrue();
  expect(existsSync(folder)).toBeFalse();

  expect(ctx.log.lines).toStrictEqual([
    `atc: kept the workspace ${path} of forgotten session ${session.id}: 1 uncommitted or untracked path`,
  ]);
});

test("it keeps both folders, and runs no check, when atc could not confirm that the session's process exited", async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work });
  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(folder, { recursive: true });

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

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: false,
  });

  expect(workspace).toStrictEqual({
    outcome: 'kept',
    path: git.work,
    reasons: ["unchecked: atc could not confirm that the session's process exited"],
  });

  expect(existsSync(git.work)).toBeTrue();
  expect(existsSync(folder)).toBeTrue();
  expect(ctx.provider.commands).toBeEmpty();

  expect(ctx.log.lines).toStrictEqual([
    `atc: kept the workspace ${git.work} of forgotten session ${session.id}: unchecked: atc could not confirm that the session's process exited`,
    `atc: left the state folder of session ${session.id}: unchecked: atc could not confirm that the session's process exited`,
  ]);
});

test('it removes a workspace with an unpushed commit under the none check, and logs what it held', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work });
  const path = realpathSync(git.work);

  await $`git commit --quiet --allow-empty -m wip`.env(git.env).cwd(git.work).quiet();

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

  const cleanup = createForgetCleanup({
    manager: ctx.manager,
    store: ctx.store,
    stateDir: ctx.stateDir,
    removeDir: (directory) => rm(directory, { recursive: true, force: true }),
    settings: { enabled: true, check: 'none' },
  });

  const workspace = await cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({
    outcome: 'removed',
    path,
    found: ['1 unpushed commit on main'],
  });

  expect(existsSync(git.work)).toBeFalse();

  expect(ctx.log.lines).toStrictEqual([
    `atc: removed the workspace ${path} of forgotten session ${session.id}, which held 1 unpushed commit on main`,
  ]);
});

test('it keeps both folders when cleanup is off', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work });
  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(folder, { recursive: true });

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

  const cleanup = createForgetCleanup({
    manager: ctx.manager,
    store: ctx.store,
    stateDir: ctx.stateDir,
    removeDir: (directory) => rm(directory, { recursive: true, force: true }),
    settings: { enabled: false, check: 'none' },
  });

  const workspace = await cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(git.work)).toBeTrue();
  expect(existsSync(folder)).toBeTrue();
  expect(ctx.provider.commands).toBeEmpty();
});

test('it runs no check when the forget destroyed the host, and still removes the state folder', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work });
  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(folder, { recursive: true });

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

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: true,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(ctx.provider.commands).toBeEmpty();
  expect(existsSync(folder)).toBeFalse();
});

test('it leaves a workspace whose build never finished', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work });

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
    { phase: 'failed', errorCode: 'workspace_interrupted' },
    2000,
  );

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(git.work)).toBeTrue();
  expect(ctx.provider.commands).toBeEmpty();
});

test('it reports nothing for a workspace someone already removed', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const gone = join(git.directory, 'shop-main-3');
  const session = buildMockSession({ cwd: gone });

  await ctx.store.createMaterialization(
    { sessionID: session.id, target: 'local', directory: gone, sourceKind: 'git', withheldEnv: [] },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: git.sha, materializedAt: 2000 },
    2000,
  );

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(ctx.log.lines).toBeEmpty();
});

test('it logs and leaves a state folder whose session id would reach outside the sessions folder', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ id: toSessionID('../records'), cwd: '/srv/work/shop-main' });
  const records = join(ctx.stateDir, 'records');

  mkdirSync(records, { recursive: true });

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(records)).toBeTrue();

  expect(ctx.log.lines).toStrictEqual([
    `atc: left the state folder of session ../records, since its id names no folder of its own under ${join(ctx.stateDir, 'sessions')}`,
  ]);
});

test('it keeps, and runs no check on, the workspace of a session whose target changed since it started', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work, targetIdentity: 'remote-vm:earlier-host' });

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

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({
    outcome: 'kept',
    path: git.work,
    reasons: [
      "unchecked: execution target 'local' changed since this session started on it (was remote-vm:earlier-host, now local-pty:test). Restore the target's earlier config to use the session, or kill it",
    ],
  });

  expect(existsSync(git.work)).toBeTrue();
  expect(ctx.provider.commands).toBeEmpty();
});

test("it leaves another session's state folder that a session id names through a dot-dot segment", async () => {
  const ctx = await setupTest();

  const session = buildMockSession({
    id: toSessionID('unused/../kept'),
    cwd: '/srv/work/shop-main',
  });

  const kept = join(ctx.stateDir, 'sessions', 'kept');

  mkdirSync(kept, { recursive: true });

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(kept)).toBeTrue();

  expect(ctx.log.lines).toStrictEqual([
    `atc: left the state folder of session unused/../kept, since its id names no folder of its own under ${join(ctx.stateDir, 'sessions')}`,
  ]);
});

test('it keeps a workspace a listed session reaches through a symlink, as the removal finds it', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const session = buildMockSession({ cwd: git.work });
  const alias = join(git.directory, 'alias');
  const path = realpathSync(git.work);

  symlinkSync(git.work, alias);

  ctx.manager.sessions = [buildMockSession({ cwd: alias })];

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

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({
    outcome: 'kept',
    path,
    reasons: ["in use: a listed session's directory lies inside it, or it moved"],
  });

  expect(existsSync(join(git.work, 'README.md'))).toBeTrue();
});

test('it never removes a clean pushed checkout that a symlink in place of the workspace leads to', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });
  const elsewhere = await createGitFixture({ prefix: 'atc-forget-cleanup-elsewhere-' });

  const workspaceDir = join(git.directory, 'shop-main');
  const session = buildMockSession({ cwd: workspaceDir });

  symlinkSync(elsewhere.work, workspaceDir);

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: workspaceDir,
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
      sha: elsewhere.sha,
      materializedAt: 2000,
    },
    2000,
  );

  const workspace = await ctx.cleanup.removeSessionFolders(session, {
    hostDestroyed: false,
    harnessEnded: true,
  });

  expect(workspace).toStrictEqual({
    outcome: 'kept',
    path: workspaceDir,
    reasons: [
      'not the checkout atc created: a symlink, or no git checkout of its commit at its top',
    ],
  });

  expect(existsSync(join(elsewhere.work, 'README.md'))).toBeTrue();
});
