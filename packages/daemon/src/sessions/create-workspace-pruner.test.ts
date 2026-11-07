import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createStateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  buildStubClock,
  buildStubLog,
  createGitFixture,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { buildSeeder } from '../test-utils/build-seeder';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubLocalProvider } from '../testing/build-stub-local-provider';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createSessionManager } from './create-session-manager';
import { createWorkspacePruner } from './create-workspace-pruner';
import { readDirBytes } from './read-dir-bytes';
import { readSubdirNames } from './read-subdir-names';
import { WORKSPACE_CHECK_SCRIPT } from './run-workspace-check';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-workspace-pruner-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const provider = buildStubLocalProvider();

  // a target on another machine whose hosts stay up, and one the config names with no provider
  const far = buildStubMemoryProvider({ remote: true });

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [buildStubHarnessAdapter()],
    targets: [
      buildMockExecutionTarget({ id: 'local', identity: 'local-pty:test', provider }),
      buildMockExecutionTarget({
        id: 'box',
        identity: 'box:test',
        provider: buildStubLocalProvider({ capabilities: { suspend: true, destroy: true } }),
      }),
      buildMockExecutionTarget({ id: 'far', identity: 'far:test', provider: far }),
      buildMockExecutionTarget({ id: 'stale', identity: 'stale:test', provider: null }),
    ],
  });

  const log = buildStubLog();

  manager.log = log.log;

  const stateDir = join(temporaryDirectory.path, 'state');
  const root = join(temporaryDirectory.path, 'workspaces');

  const deps = {
    manager,
    store,
    targets: ['local', 'box', 'far', 'stale'],
    workspaceRoots: { root, targetRoots: new Map([['far', '~/work']]) },
    homeDir: temporaryDirectory.path,
    stateDir,
    readSubdirNames,
    readDirBytes,
    removeDir: (directory: string) => rm(directory, { recursive: true, force: true }),
    settings: { enabled: true, check: 'unpushed' } as const,
  };

  const seedDeps = { store, dbPath, clock: buildStubClock(1000) };

  return {
    store,
    manager,
    provider,
    far,
    log,
    stateDir,
    root,
    pruner: createWorkspacePruner(deps),
    createPruner: (removeDir: (directory: string) => Promise<void>) =>
      createWorkspacePruner({ ...deps, removeDir }),
    seed: buildSeeder(seedDeps),
  };
}

test('it lists a clean workspace as remove, a dirty one as keep, and a folder with no row as skip on a dry run, and removes nothing', async () => {
  const ctx = await setupTest();
  const clean = await createGitFixture({ prefix: 'atc-pruner-clean-' });
  const dirty = await createGitFixture({ prefix: 'atc-pruner-dirty-' });

  const handMade = join(ctx.root, 'notes-by-hand');

  mkdirSync(handMade, { recursive: true });
  writeFileSync(join(dirty.work, 'draft.md'), '# order list\n');

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-clean'),
    directory: clean.work,
    sha: clean.sha,
  });

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-dirty'),
    directory: dirty.work,
    sha: dirty.sha,
  });

  const prune = await ctx.pruner.prune(false);

  expect(prune).toStrictEqual({
    dryRun: true,
    folders: [
      {
        verdict: 'remove',
        kind: 'workspace',
        path: realpathSync(clean.work),
        bytes: expect.any(Number),
        found: [],
      },
      {
        verdict: 'keep',
        kind: 'workspace',
        path: realpathSync(dirty.work),
        bytes: expect.any(Number),
        reasons: ['1 uncommitted or untracked path'],
      },
      { verdict: 'skip', kind: 'workspace', path: handMade, reason: 'no atc record' },
    ],
  });

  expect([clean.work, dirty.work, handMade]).toSatisfyAll((path: string) => existsSync(path));
});

test('it takes away the remove workspaces and orphaned state folders with remove, and leaves the keep and skip folders', async () => {
  const ctx = await setupTest();
  const clean = await createGitFixture({ prefix: 'atc-pruner-clean-' });
  const dirty = await createGitFixture({ prefix: 'atc-pruner-dirty-' });

  const handMade = join(ctx.root, 'notes-by-hand');
  const orphan = join(ctx.stateDir, 'sessions', 'forgotten-long-ago', 'scratch');

  mkdirSync(handMade, { recursive: true });
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, 'notes.txt'), 'flour, sugar\n');
  writeFileSync(join(dirty.work, 'draft.md'), '# order list\n');

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-clean'),
    directory: clean.work,
    sha: clean.sha,
  });

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-dirty'),
    directory: dirty.work,
    sha: dirty.sha,
  });

  const cleanPath = realpathSync(clean.work);

  const prune = await ctx.pruner.prune(true);

  expect(prune).toStrictEqual({
    dryRun: false,
    folders: [
      {
        verdict: 'remove',
        kind: 'workspace',
        path: cleanPath,
        bytes: expect.any(Number),
        found: [],
      },
      {
        verdict: 'keep',
        kind: 'workspace',
        path: realpathSync(dirty.work),
        bytes: expect.any(Number),
        reasons: ['1 uncommitted or untracked path'],
      },
      { verdict: 'skip', kind: 'workspace', path: handMade, reason: 'no atc record' },
      {
        verdict: 'remove',
        kind: 'state',
        path: join(ctx.stateDir, 'sessions', 'forgotten-long-ago'),
        bytes: expect.any(Number),
        found: [],
      },
    ],
  });

  expect({
    clean: existsSync(clean.work),
    dirty: existsSync(join(dirty.work, 'draft.md')),
    handMade: existsSync(handMade),
    orphan: existsSync(join(ctx.stateDir, 'sessions', 'forgotten-long-ago')),
  }).toStrictEqual({ clean: false, dirty: true, handMade: true, orphan: false });
});

test('it logs each folder a prune with remove takes away or keeps', async () => {
  const ctx = await setupTest();
  const clean = await createGitFixture({ prefix: 'atc-pruner-clean-' });
  const dirty = await createGitFixture({ prefix: 'atc-pruner-dirty-' });

  const orphan = join(ctx.stateDir, 'sessions', 'forgotten-long-ago');

  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(dirty.work, 'draft.md'), '# order list\n');

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-clean'),
    directory: clean.work,
    sha: clean.sha,
  });

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-dirty'),
    directory: dirty.work,
    sha: dirty.sha,
  });

  const cleanPath = realpathSync(clean.work);

  await ctx.pruner.prune(true);

  expect(ctx.log.lines).toStrictEqual([
    `atc: prune removed the workspace ${cleanPath}`,
    `atc: prune kept the workspace ${realpathSync(dirty.work)}: 1 uncommitted or untracked path`,
    `atc: prune removed the state folder ${orphan}`,
  ]);
});

test('it refuses a spawn into a workspace while the check that decides its removal runs', async () => {
  const ctx = await setupTest();
  const clean = await createGitFixture({ prefix: 'atc-pruner-held-' });

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-clean'),
    directory: clean.work,
    sha: clean.sha,
  });

  ctx.provider.holdCommands();

  const pruning = ctx.pruner.prune(true);

  await waitFor(() => {
    expect(ctx.provider.hasHeldCommands()).toBeTrue();
  });

  ctx.provider.finishCommands();
  ctx.provider.holdCommands();

  await waitFor(() => {
    expect(ctx.provider.commands.at(-1)?.argv).toContain(WORKSPACE_CHECK_SCRIPT);
  });

  const spawned = await Promise.allSettled([
    ctx.manager.spawn({ cwd: clean.work, name: 'late-baker', prompt: '', cols: 80, rows: 24 }),
  ]);

  ctx.provider.finishCommands();

  await pruning;

  expect(spawned).toMatchObject([{ status: 'rejected', reason: { code: 'workspace_overlap' } }]);
});

test('it keeps a state folder whose session starts to spawn while the prune checks a workspace', async () => {
  const ctx = await setupTest();
  const clean = await createGitFixture({ prefix: 'atc-pruner-late-' });

  const late = toSessionID('late-spawn');
  const folder = join(ctx.stateDir, 'sessions', late);
  const gate = Promise.withResolvers<null>();

  mkdirSync(folder, { recursive: true });

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-clean'),
    directory: clean.work,
    sha: clean.sha,
  });

  ctx.provider.holdCommands();

  const pruning = ctx.pruner.prune(true);

  await waitFor(() => {
    expect(ctx.provider.hasHeldCommands()).toBeTrue();
  });

  ctx.provider.finishCommands();
  ctx.provider.holdCommands();

  await waitFor(() => {
    expect(ctx.provider.commands.at(-1)?.argv).toContain(WORKSPACE_CHECK_SCRIPT);
  });

  const spawn = ctx.manager.spawn({
    id: late,
    cwd: ctx.root,
    name: 'late-baker',
    prompt: '',
    cols: 80,
    rows: 24,
    materialize: () => gate.promise,
  });

  registerTestCleanup(async () => {
    gate.resolve(null);

    await Promise.allSettled([spawn]);
  });

  ctx.provider.finishCommands();

  const prune = await pruning;

  expect(prune.folders).toPartiallyContain({
    verdict: 'keep',
    kind: 'state',
    path: folder,
    reasons: ['in use by session late-spawn'],
  });

  expect(existsSync(folder)).toBeTrue();
});

test('it keeps a workspace unchecked when its target refuses to run it', async () => {
  const ctx = await setupTest();
  const stale = await createGitFixture({ prefix: 'atc-pruner-stale-' });

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-stale'),
    target: 'stale',
    directory: stale.work,
    sha: stale.sha,
  });

  const prune = await ctx.pruner.prune(true);

  expect(prune.folders).toStrictEqual([
    {
      verdict: 'keep',
      kind: 'workspace',
      path: stale.work,
      bytes: null,
      reasons: [expect.stringMatching(/^unchecked: /u)],
    },
  ]);
});

test('it keeps a state folder whose removal fails, with the reason', async () => {
  const ctx = await setupTest();

  const orphan = join(ctx.stateDir, 'sessions', 'forgotten-long-ago');

  // rmdir refuses a folder that holds a file, even for root
  const pruner = ctx.createPruner(rmdir);

  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, 'transcript.jsonl'), '{}\n');

  const prune = await pruner.prune(true);

  expect(prune.folders).toStrictEqual([
    {
      verdict: 'keep',
      kind: 'state',
      path: orphan,
      bytes: expect.any(Number),
      reasons: [`removing it failed: ENOTEMPTY: directory not empty, rmdir '${orphan}'`],
    },
  ]);
});

test('it lists no root relative to the home of another machine', async () => {
  const ctx = await setupTest();

  await ctx.pruner.prune(false);

  expect(ctx.far.commands).toStrictEqual([]);
});

test('it logs nothing on a dry run', async () => {
  const ctx = await setupTest();
  const dirty = await createGitFixture({ prefix: 'atc-pruner-dirty-' });

  writeFileSync(join(dirty.work, 'draft.md'), '# order list\n');

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-dirty'),
    directory: dirty.work,
    sha: dirty.sha,
  });

  await ctx.pruner.prune(false);

  expect(ctx.log.lines).toStrictEqual([]);
});

test('it never lists a folder a listed session uses, even when an older row names it', async () => {
  const ctx = await setupTest();
  const reused = await createGitFixture({ prefix: 'atc-pruner-reused-' });

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-first'),
    directory: reused.work,
    sha: reused.sha,
  });

  ctx.manager.sessions.push(buildMockSession({ id: toSessionID('plain-later'), cwd: reused.work }));

  const prune = await ctx.pruner.prune(true);

  expect(prune).toStrictEqual({ dryRun: false, folders: [] });
  expect(existsSync(reused.work)).toBeTrue();
});

test('it never lists a folder a session that only the stored fleet lists runs in', async () => {
  const ctx = await setupTest();
  const restorable = await createGitFixture({ prefix: 'atc-pruner-restorable-' });

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-first'),
    directory: restorable.work,
    sha: restorable.sha,
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('not-yet-restored'), cwd: restorable.work }),
  ]);

  const prune = await ctx.pruner.prune(true);

  expect(prune).toStrictEqual({ dryRun: false, folders: [] });
  expect(existsSync(restorable.work)).toBeTrue();
});

test('it keeps a workspace that a session only the stored fleet lists reaches through a symlink', async () => {
  const ctx = await setupTest();
  const restorable = await createGitFixture({ prefix: 'atc-pruner-linked-' });

  const alias = join(restorable.directory, 'alias');

  symlinkSync(restorable.work, alias);

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-first'),
    directory: restorable.work,
    sha: restorable.sha,
  });

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('not-yet-restored'), cwd: join(alias, 'src') }),
  ]);

  const prune = await ctx.pruner.prune(true);

  expect(prune.folders).toPartiallyContain({
    verdict: 'keep',
    kind: 'workspace',
    reasons: ['in use by session not-yet-restored'],
  });

  expect(existsSync(restorable.work)).toBeTrue();
});

test('it keeps a workspace on a dry run that a listed session reaches through a symlink', async () => {
  const ctx = await setupTest();
  const linked = await createGitFixture({ prefix: 'atc-pruner-live-link-' });

  const alias = join(linked.directory, 'alias');

  symlinkSync(linked.work, alias);

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-first'),
    directory: linked.work,
    sha: linked.sha,
  });

  ctx.manager.sessions.push(
    buildMockSession({ id: toSessionID('plain-linked'), cwd: join(alias, 'src') }),
  );

  const prune = await ctx.pruner.prune(false);

  expect(prune.folders).toPartiallyContain({
    verdict: 'keep',
    kind: 'workspace',
    reasons: ['in use by session plain-linked'],
  });
});

test('it prunes a local workspace whose path a session on a host with a lifecycle also uses', async () => {
  const ctx = await setupTest();
  const leftover = await createGitFixture({ prefix: 'atc-pruner-same-path-' });

  await ctx.seed.readyMaterialization({
    sessionID: toSessionID('forgotten-local'),
    directory: leftover.work,
    sha: leftover.sha,
  });

  ctx.manager.sessions.push(
    buildMockSession({ id: toSessionID('cloud-live'), cwd: leftover.work, target: 'box' }),
  );

  const leftoverPath = realpathSync(leftover.work);

  const prune = await ctx.pruner.prune(true);

  expect(prune.folders).toStrictEqual([
    {
      verdict: 'remove',
      kind: 'workspace',
      path: leftoverPath,
      bytes: expect.any(Number),
      found: [],
    },
  ]);
});

test('it never lists the state folder of a session the stored fleet lists', async () => {
  const ctx = await setupTest();

  const folder = join(ctx.stateDir, 'sessions', 'not-yet-restored');

  mkdirSync(folder, { recursive: true });

  await ctx.store.writeFleet([buildMockFleetEntry({ sessionID: toSessionID('not-yet-restored') })]);

  const prune = await ctx.pruner.prune(true);

  expect(prune).toStrictEqual({ dryRun: false, folders: [] });
  expect(existsSync(folder)).toBeTrue();
});

test('it never lists the state folder of a spawn in flight', async () => {
  const ctx = await setupTest();

  const spawning = toSessionID('spawn-in-flight');
  const folder = join(ctx.stateDir, 'sessions', spawning);
  const gate = Promise.withResolvers<null>();

  mkdirSync(folder, { recursive: true });

  const spawn = ctx.manager.spawn({
    id: spawning,
    cwd: ctx.root,
    name: 'bakery',
    prompt: '',
    cols: 80,
    rows: 24,
    materialize: () => gate.promise,
  });

  registerTestCleanup(async () => {
    gate.resolve(null);

    await Promise.allSettled([spawn]);
  });

  const prune = await ctx.pruner.prune(true);

  expect(prune).toStrictEqual({ dryRun: false, folders: [] });
  expect(existsSync(folder)).toBeTrue();
});

test('it ignores a row on a target whose hosts have a lifecycle', async () => {
  const ctx = await setupTest();
  const guest = await createGitFixture({ prefix: 'atc-pruner-guest-' });

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('cloud-forgotten'),
      target: 'box',
      directory: guest.work,
      sourceKind: 'git',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    toSessionID('cloud-forgotten'),
    {
      phase: 'ready',
      repoURL: 'https://example.com/bakery.git',
      sha: guest.sha,
      materializedAt: 2000,
    },
    2000,
  );

  const prune = await ctx.pruner.prune(true);

  expect(prune).toStrictEqual({ dryRun: false, folders: [] });
  expect(existsSync(guest.work)).toBeTrue();
});
