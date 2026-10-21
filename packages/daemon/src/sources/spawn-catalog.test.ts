import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import type { SourceProvider } from '@atc/plugin-api';
import { createStateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { TargetAccess } from '../auth/target-access';
import type { ExecutionTarget } from '../fleet/build-execution-targets';
import { SessionManager } from '../sessions/sessions';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { SpawnCatalog } from './spawn-catalog';

interface SetupTestConfig {
  readonly targets: readonly ExecutionTarget[];
  readonly sources: readonly SourceProvider[];
  readonly gitTransports: readonly string[] | { readonly invalid: string };
}

// A session manager with the stub harness as its one agent, a real state
// store, and the catalog over both.
async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-spawn-catalog-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const manager = new SessionManager(
    null,
    store,
    join(temporaryDirectory.path, 'status.json'),
    [buildStubHarnessAdapter()],
    config.targets,
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const catalog = new SpawnCatalog({
    manager,
    store,
    build: 'atc/test',
    targets: config.targets,
    defaultTarget: config.targets[0]?.id ?? null,
    targetErrors: [],
    sources: config.sources,
    gitTransports: config.gitTransports,
  });

  return { store, catalog };
}

test('it lists the agents, the targets, and claude as the spawn agent when none is set', async () => {
  const ctx = await setupTest({
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    sources: [],
    gitTransports: ['https'],
  });

  expect(ctx.catalog.collectAgents()).toMatchObject({
    daemon: { build: 'atc/test', platform: process.platform, arch: process.arch },
    agents: [{ id: 'claude' }],
    targets: [{ id: 'local', identity: 'local-pty:test', available: true, default: true }],
    spawnDefaults: { agent: 'claude', target: 'local' },
    configRevision: expect.toBeString(),
    targetErrors: [],
    sources: [],
  });
});

test('it lists the sources it offers in order', async () => {
  const ctx = await setupTest({
    targets: [],
    sources: [
      { id: 'dirs', label: 'Directories', kind: 'path', list: mock(), interpret: mock() },
      { id: 'github', label: 'GitHub', kind: 'git', list: mock(), interpret: mock() },
    ],
    gitTransports: ['https'],
  });

  expect(ctx.catalog.collectAgents().sources).toStrictEqual([
    { id: 'dirs', label: 'Directories', kind: 'path' },
    { id: 'github', label: 'GitHub', kind: 'git' },
  ]);
});

test('it lists each spawned directory once', async () => {
  const ctx = await setupTest({ targets: [], sources: [], gitTransports: ['https'] });

  await ctx.store.recordSpawnDir('/work/app', { target: 'local', targetIdentity: 'l:1' }, 1);
  await ctx.store.recordSpawnDir('/work/app', { target: 'box', targetIdentity: 'b:1' }, 2);

  const dirs = await ctx.catalog.readSpawnDirs(null);

  expect(dirs).toStrictEqual(['/work/app']);
});

test('it lists a principal only the directories spawned on targets it may use', async () => {
  const ctx = await setupTest({ targets: [], sources: [], gitTransports: ['https'] });

  await ctx.store.recordSpawnDir('/work/app', { target: 'local', targetIdentity: 'l:1' }, 1);
  await ctx.store.recordSpawnDir('/work/ops', { target: 'box', targetIdentity: 'b:1' }, 2);

  const dirs = await ctx.catalog.readSpawnDirs(
    new TargetAccess([{ target: 'box', targetIdentity: 'b:1' }]),
  );

  expect(dirs).toStrictEqual(['/work/ops']);
});

test('it finds an offered source by its id', async () => {
  const github: SourceProvider = {
    id: 'github',
    label: 'GitHub',
    kind: 'git',
    list: mock(),
    interpret: mock(),
  };

  const ctx = await setupTest({ targets: [], sources: [github], gitTransports: ['https'] });

  expect(ctx.catalog.findSource('github')).toBe(github);
});

test('it finds no source under an id it does not offer', async () => {
  const ctx = await setupTest({ targets: [], sources: [], gitTransports: ['https'] });

  expect(ctx.catalog.findSource('github')).toBeNull();
});

test('it lists each alternate URL the sources know once', async () => {
  const ctx = await setupTest({
    targets: [],
    sources: [
      {
        id: 'github',
        label: 'GitHub',
        kind: 'git',
        list: mock(),
        interpret: mock(),
        findAlternateURLs: () => ['git@example.com:team/app.git'],
      },
      {
        id: 'mirror',
        label: 'Mirror',
        kind: 'git',
        list: mock(),
        interpret: mock(),
        findAlternateURLs: () => ['git@example.com:team/app.git', 'https://mirror.test/app.git'],
      },
    ],
    gitTransports: ['https'],
  });

  expect(ctx.catalog.collectAlternateGitURLs('https://example.com/team/app.git')).toStrictEqual([
    'git@example.com:team/app.git',
    'https://mirror.test/app.git',
  ]);
});

test('it refuses a repository check when the config holds an invalid transport list', async () => {
  const ctx = await setupTest({
    targets: [],
    sources: [],
    gitTransports: { invalid: 'ftp is not a transport' },
  });

  expect(() =>
    ctx.catalog.checkRepositoryAccess({ url: 'https://example.com/team/app.git' }),
  ).toThrow(expect.objectContaining({ code: 'git_transports_invalid' }));
});
