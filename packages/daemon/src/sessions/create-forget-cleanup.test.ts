import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStateStore } from '@atc/store';
import {
  buildStubLog,
  createGitFixture,
  createMigratedStateDB,
  registerTestCleanup,
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
  const git = await createGitFixture({ prefix: 'atc-forget-cleanup-' });

  const dbPath = join(git.directory, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const provider = buildStubLocalProvider();

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(git.directory, 'status.json'),
    adapters: [buildStubHarnessAdapter()],
    targets: [buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider })],
  });

  const log = buildStubLog();

  manager.log = log.log;

  const stateDir = join(git.directory, 'state');

  return {
    store,
    manager,
    provider,
    log,
    stateDir,
    directory: git.directory,
    work: git.work,
    sha: git.sha,
    env: git.env,
    cleanup: createForgetCleanup({
      manager,
      store,
      stateDir,
      settings: { enabled: true, check: 'unpushed' },
    }),
  };
}

test('it removes a pushed workspace and the state folder, and logs the removal', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ cwd: ctx.work });
  const folder = join(ctx.stateDir, 'sessions', session.id);
  const path = realpathSync(ctx.work);

  mkdirSync(folder, { recursive: true });

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: ctx.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: ctx.sha, materializedAt: 2000 },
    2000,
  );

  const workspace = await ctx.cleanup.removeSessionFolders(session, false);

  expect(workspace).toStrictEqual({ outcome: 'removed', path, found: [] });
  expect(existsSync(ctx.work)).toBeFalse();
  expect(existsSync(folder)).toBeFalse();

  expect(ctx.log.lines).toStrictEqual([
    `atc: removed the workspace ${path} of forgotten session ${session.id}`,
  ]);
});

test('it keeps a workspace with an uncommitted change, removes the state folder, and logs why', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ cwd: ctx.work });
  const folder = join(ctx.stateDir, 'sessions', session.id);
  const path = realpathSync(ctx.work);

  mkdirSync(folder, { recursive: true });
  writeFileSync(join(ctx.work, 'README.md'), 'hello, unsaved\n');

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: ctx.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: ctx.sha, materializedAt: 2000 },
    2000,
  );

  const workspace = await ctx.cleanup.removeSessionFolders(session, false);

  expect(workspace).toStrictEqual({
    outcome: 'kept',
    path,
    reasons: ['1 uncommitted or untracked path'],
  });

  expect(existsSync(join(ctx.work, 'README.md'))).toBeTrue();
  expect(existsSync(folder)).toBeFalse();

  expect(ctx.log.lines).toStrictEqual([
    `atc: kept the workspace ${path} of forgotten session ${session.id}: 1 uncommitted or untracked path`,
  ]);
});

test('it removes a workspace with an unpushed commit under the none check, and logs what it held', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ cwd: ctx.work });
  const path = realpathSync(ctx.work);

  await $`git commit --quiet --allow-empty -m wip`.env(ctx.env).cwd(ctx.work).quiet();

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: ctx.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: ctx.sha, materializedAt: 2000 },
    2000,
  );

  const cleanup = createForgetCleanup({
    manager: ctx.manager,
    store: ctx.store,
    stateDir: ctx.stateDir,
    settings: { enabled: true, check: 'none' },
  });

  const workspace = await cleanup.removeSessionFolders(session, false);

  expect(workspace).toStrictEqual({
    outcome: 'removed',
    path,
    found: ['1 unpushed commit on main'],
  });

  expect(existsSync(ctx.work)).toBeFalse();

  expect(ctx.log.lines).toStrictEqual([
    `atc: removed the workspace ${path} of forgotten session ${session.id}, which held 1 unpushed commit on main`,
  ]);
});

test('it keeps both folders when cleanup is off', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ cwd: ctx.work });
  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(folder, { recursive: true });

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: ctx.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: ctx.sha, materializedAt: 2000 },
    2000,
  );

  const cleanup = createForgetCleanup({
    manager: ctx.manager,
    store: ctx.store,
    stateDir: ctx.stateDir,
    settings: { enabled: false, check: 'none' },
  });

  const workspace = await cleanup.removeSessionFolders(session, false);

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(ctx.work)).toBeTrue();
  expect(existsSync(folder)).toBeTrue();
  expect(ctx.provider.commands).toBeEmpty();
});

test('it runs no check when the forget destroyed the host, and still removes the state folder', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ cwd: ctx.work });
  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(folder, { recursive: true });

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: ctx.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: ctx.sha, materializedAt: 2000 },
    2000,
  );

  const workspace = await ctx.cleanup.removeSessionFolders(session, true);

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(ctx.provider.commands).toBeEmpty();
  expect(existsSync(folder)).toBeFalse();
});

test('it leaves a workspace whose build never finished', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ cwd: ctx.work });

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: ctx.work,
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

  const workspace = await ctx.cleanup.removeSessionFolders(session, false);

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(ctx.work)).toBeTrue();
  expect(ctx.provider.commands).toBeEmpty();
});

test('it reports nothing for a workspace someone already removed', async () => {
  const ctx = await setupTest();

  const gone = join(ctx.directory, 'shop-main-3');
  const session = buildMockSession({ cwd: gone });

  await ctx.store.createMaterialization(
    { sessionID: session.id, target: 'local', directory: gone, sourceKind: 'git', withheldEnv: [] },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: ctx.sha, materializedAt: 2000 },
    2000,
  );

  const workspace = await ctx.cleanup.removeSessionFolders(session, false);

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(ctx.log.lines).toBeEmpty();
});

test('it logs and leaves a state folder whose session id would reach outside the sessions folder', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ id: toSessionID('../records'), cwd: ctx.work });
  const records = join(ctx.stateDir, 'records');

  mkdirSync(records, { recursive: true });

  const workspace = await ctx.cleanup.removeSessionFolders(session, false);

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(records)).toBeTrue();

  expect(ctx.log.lines).toStrictEqual([
    `atc: left the state folder of session ../records, since its id names no folder of its own under ${join(ctx.stateDir, 'sessions')}`,
  ]);
});

test('it keeps a workspace a listed session reaches through a symlink, as the removal finds it', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ cwd: ctx.work });
  const alias = join(ctx.directory, 'alias');
  const path = realpathSync(ctx.work);

  symlinkSync(ctx.work, alias);

  ctx.manager.sessions = [buildMockSession({ cwd: alias })];

  await ctx.store.createMaterialization(
    {
      sessionID: session.id,
      target: 'local',
      directory: ctx.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    session.id,
    { phase: 'ready', repoURL: 'https://example.com/shop.git', sha: ctx.sha, materializedAt: 2000 },
    2000,
  );

  const workspace = await ctx.cleanup.removeSessionFolders(session, false);

  expect(workspace).toStrictEqual({
    outcome: 'kept',
    path,
    reasons: ["in use: a listed session's directory lies inside it, or it moved"],
  });

  expect(existsSync(join(ctx.work, 'README.md'))).toBeTrue();
});
