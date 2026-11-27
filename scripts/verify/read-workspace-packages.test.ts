import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { readWorkspacePackages } from './read-workspace-packages.ts';

function setupTest() {
  const rootDir = createTempDir('atc-workspace-packages-').path;

  return {
    rootDir,
    writeJSON: (path: string, value: unknown) => {
      mkdirSync(join(rootDir, path, '..'), { recursive: true });
      writeFileSync(join(rootDir, path), JSON.stringify(value));
    },
  };
}

test('it reads each workspace package with only its run-time workspace dependencies', async () => {
  const ctx = setupTest();

  ctx.writeJSON('package.json', {
    workspaces: { packages: ['packages/*', 'packages/harnesses/*'] },
  });

  ctx.writeJSON('packages/kettle/package.json', {
    name: '@atc/kettle',
    dependencies: { '@atc/clock': 'workspace:*', zod: 'catalog:' },
    devDependencies: { '@atc/teapot': 'workspace:*' },
  });

  ctx.writeJSON('packages/harnesses/steam/package.json', { name: '@atc/harness-steam' });
  ctx.writeJSON('docs/package.json', { name: '@atc/docs' });

  const packages = await readWorkspacePackages(ctx.rootDir);

  expect(packages).toStrictEqual([
    { folder: 'packages/harnesses/steam', name: '@atc/harness-steam', workspaceDependencies: [] },
    { folder: 'packages/kettle', name: '@atc/kettle', workspaceDependencies: ['@atc/clock'] },
  ]);
});
