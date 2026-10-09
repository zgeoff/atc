import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { DaemonError } from '../protocol/daemon-error';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createMigratedStateDB } from '../test-utils/create-migrated-state-db';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import type { CommandSpec } from './execution-provider';
import { materializeWorkspace } from './materialize-workspace';

async function setupTest() {
  const tmp = setupTempDir('atc-materialize-');
  const scratch = join(tmp.dir, 'scratch');
  const dbPath = join(tmp.dir, 'state.db');

  // The staging root must exist for a clone to stage in it.
  mkdirSync(scratch);

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  return { scratch, store };
}

test('it leaves no staging directory behind when the materialization row cannot be written', async () => {
  const ctx = await setupTest();

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-1'),
      target: 'box',
      dir: join(ctx.scratch, 'other'),
      sourceKind: 'git',
      withheldEnv: [],
    },
    Date.now(),
  );

  const materialized = materializeWorkspace(
    {
      sessionID: toSessionID('s-1'),
      target: 'box',
      dir: join(ctx.scratch, 'ws'),
      source: { kind: 'git', url: 'https://example.com/repo.git', ref: 'main' },
      inPlace: false,
    },
    {
      requireProvider: () => {
        throw new Error('no provider call is expected');
      },
      store: ctx.store,
      log: () => {},
      readyHost: () => Promise.reject(new Error('no host is expected')),
      removeClaim: () => Promise.resolve(true),
      stagingRoot: ctx.scratch,
      gitTransports: ['https', 'ssh'],
    },
  );

  expect(materialized).rejects.toThrow(
    'UNIQUE constraint failed: workspace_materialization.session_id',
  );

  expect(readdirSync(ctx.scratch)).toStrictEqual([]);
});

test('it uploads the commit it pinned for the clone inside the host when the branch moves before the upload', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-materialize-git-' });

  const host = buildStubExecutionProvider();
  const dir = join(ctx.scratch, 'ws');

  // The host fails its clone, and the branch moves on upstream before the
  // daemon uploads the workspace instead.
  const provider = {
    ...host,
    runCommand: async (spec: CommandSpec) => {
      if (!spec.argv.some((arg) => arg.includes('--filter=blob:none'))) {
        return host.runCommand(spec);
      }

      writeFileSync(join(git.work, 'README.md'), 'moved\n');

      await $`git commit -q -am moved && git push -q origin main`
        .env(git.env)
        .cwd(git.work)
        .quiet();

      return { exitCode: 128, stdout: '', stderr: 'fatal: the host cannot reach the repository\n' };
    },
  };

  const materialized = await materializeWorkspace(
    {
      sessionID: toSessionID('s-1'),
      target: 'box',
      dir,
      source: { kind: 'git', url: git.upstream, ref: 'main' },
      inPlace: false,
    },
    {
      requireProvider: () => provider,
      store: ctx.store,
      log: () => {},
      readyHost: () => Promise.resolve({ host: 'h', dir }),
      removeClaim: () => Promise.resolve(true),
      stagingRoot: ctx.scratch,
      gitTransports: ['file'],
      cloneOnTarget: true,
    },
  );

  expect(materialized).toMatchObject({
    kind: 'ready',
    workspace: { sha: git.sha },
    branch: 'main',
  });
});

test('it holds the phase a refusal failed in when the refusal carries none', async () => {
  const ctx = await setupTest();

  const materialized = materializeWorkspace(
    {
      sessionID: toSessionID('s-1'),
      target: 'box',
      dir: join(ctx.scratch, 'ws'),
      source: { kind: 'git', url: 'https://example.com/repo.git', ref: 'main' },
      inPlace: false,
    },
    {
      requireProvider: () => {
        throw new Error('no provider call is expected');
      },
      store: ctx.store,
      log: () => {},
      readyHost: () =>
        Promise.reject(
          new DaemonError(
            'git_output_open',
            'git ls-remote exited 0, but its output was still open 30000 ms later',
          ),
        ),
      removeClaim: () => Promise.resolve(true),
      stagingRoot: ctx.scratch,
      gitTransports: ['https', 'ssh'],
    },
  );

  expect(materialized).rejects.toMatchObject({
    code: 'git_output_open',
    data: { phase: 'resolving' },
  });
});
