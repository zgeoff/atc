import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { loadWorkspacePackages } from './load-workspace-packages';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('load-workspace-packages-');

  return { dir: tmp.path };
}

test('it lists each package the workspace globs match, with its workspace dependencies', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ workspaces: { packages: ['packages/*', 'packages/harnesses/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({ name: '@atc/core' }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/harnesses/claude/package.json'),
    JSON.stringify({
      name: '@atc/harness-claude',
      dependencies: { '@atc/core': 'workspace:*', zod: 'catalog:' },
    }),
  );

  await Bun.write(join(ctx.dir, 'packages/notes/README.md'), '# notes\n');

  expect(loadWorkspacePackages(ctx.dir)).toStrictEqual([
    { name: 'core', dir: 'packages/core', deps: [] },
    { name: 'harness-claude', dir: 'packages/harnesses/claude', deps: ['core'] },
  ]);
});

test('it rejects a package named outside the @atc scope', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(join(ctx.dir, 'packages/core/package.json'), JSON.stringify({ name: 'core' }));

  expect(() => loadWorkspacePackages(ctx.dir)).toThrow();
});
