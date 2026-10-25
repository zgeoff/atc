import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin, runCommand, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { z } from 'zod';

// A temp directory standing in for a repo root, and the real repo, whose
// test-home script and tool versions the stand-in reuses
function setupTest() {
  const temporaryDirectory = setupTempDir('test-plugin-');

  return { directory: temporaryDirectory.path, repo: join(import.meta.dir, '..') };
}

test('it tests a plugin in a workspace of its manifest closure and the test helpers', async () => {
  const ctx = setupTest();
  const catalogSchema = z.record(z.string(), z.string());
  const rootText = readFileSync(join(ctx.repo, 'package.json'), 'utf8');

  const rootManifest = z
    .object({ workspaces: z.object({ catalog: catalogSchema }) })
    .parse(JSON.parse(rootText));

  // the tools the workspace's type check and tests need, at the repo's versions
  const catalog = rootManifest.workspaces.catalog;

  await Bun.write(
    join(ctx.directory, 'package.json'),
    JSON.stringify({
      name: 'root',
      private: true,
      workspaces: {
        packages: ['packages/*', 'packages/*/*'],
        catalog: {
          typescript: catalog['typescript'],
          '@types/bun': catalog['@types/bun'],
          '@zgeoff/bun-test-extended': catalog['@zgeoff/bun-test-extended'],
        },
      },
      devDependencies: {
        typescript: 'catalog:',
        '@types/bun': 'catalog:',
        '@zgeoff/bun-test-extended': 'catalog:',
        '@atc/store': 'workspace:*',
        oxlint: 'catalog:',
      },
    }),
  );

  await Bun.write(join(ctx.directory, 'bunfig.toml'), '[install]\nlinker = "isolated"\n');

  await Bun.write(
    join(ctx.directory, 'tsconfig.base.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2024',
        module: 'Preserve',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        noEmit: true,
      },
    }),
  );

  await Bun.write(
    join(ctx.directory, 'scripts/with-test-home.sh'),
    Bun.file(join(ctx.repo, 'scripts/with-test-home.sh')),
  );

  await Bun.write(join(ctx.directory, 'mods/README.md'), '# mods\n');

  await Bun.write(
    join(ctx.directory, 'packages/core/package.json'),
    JSON.stringify({ name: '@atc/core', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/core/src/index.ts'),
    "export const CORE = 'core';\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/plugin-api/package.json'),
    JSON.stringify({
      name: '@atc/plugin-api',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/core': 'workspace:*', '@atcx/contract': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/plugin-api/src/index.ts'),
    "import { CORE } from '@atc/core';\nimport { CONTRACT } from '@atcx/contract';\n\nexport const API = [CORE, CONTRACT, 'api'].join('-');\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/package.json'),
    JSON.stringify({ name: '@atcx/contract', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/contract/src/index.ts'),
    "export const CONTRACT = 'contract';\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/store/package.json'),
    JSON.stringify({ name: '@atc/store', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/store/src/index.ts'),
    "export const STORE = 'store';\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/test-utils/src/index.ts'),
    "export const FIXTURE = 'fixture';\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/harnesses/demo/package.json'),
    JSON.stringify({
      name: '@atc/harness-demo',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/plugin-api': 'workspace:*' },
      devDependencies: { '@atc/test-utils': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/harnesses/demo/src/index.ts'),
    "import { API } from '@atc/plugin-api';\n\nexport const DEMO = [API, 'demo'].join('-');\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/harnesses/demo/src/index.test.ts'),
    "import { expect, test } from 'bun:test';\nimport { FIXTURE } from '@atc/test-utils';\nimport { DEMO } from './index';\n\ntest('it builds the name', () => {\n  expect([DEMO, FIXTURE]).toStrictEqual(['core-contract-api-demo', 'fixture']);\n});\n",
  );

  const ran = await runCommand([
    process.execPath,
    join(import.meta.dir, 'test-plugin.ts'),
    'harness-demo',
    ctx.directory,
    '--keep',
  ]);

  const kept = /^test-plugin: kept (?<dir>.+)$/mu.exec(ran.stdout)?.groups?.['dir'];

  invariant(kept !== undefined);

  onTestFinished(() => {
    rmSync(kept, { recursive: true, force: true });
  });

  expect(ran.exitCode).toBe(0);
  expect(ran.stdout).toInclude('test-plugin: harness-demo passed in a workspace without the app');

  expect(
    ['core', 'contract', 'plugin-api', 'test-utils', 'harnesses/demo', 'store'].map((directory) =>
      existsSync(join(kept, 'packages', directory, 'package.json')),
    ),
  ).toStrictEqual([true, true, true, true, true, false]);

  const keptManifest = readFileSync(join(kept, 'package.json'), 'utf8');

  expect(JSON.parse(keptManifest)).toMatchObject({
    devDependencies: {
      typescript: 'catalog:',
      '@types/bun': 'catalog:',
      '@zgeoff/bun-test-extended': 'catalog:',
    },
  });

  expect(keptManifest).not.toInclude('@atc/store');
  expect(keptManifest).not.toInclude('oxlint');
});

test('it type-checks the plugin when the node on PATH fails', async () => {
  const ctx = setupTest();
  const catalogSchema = z.record(z.string(), z.string());
  const rootText = readFileSync(join(ctx.repo, 'package.json'), 'utf8');

  const rootManifest = z
    .object({ workspaces: z.object({ catalog: catalogSchema }) })
    .parse(JSON.parse(rootText));

  const catalog = rootManifest.workspaces.catalog;

  await Bun.write(
    join(ctx.directory, 'package.json'),
    JSON.stringify({
      name: 'root',
      private: true,
      workspaces: {
        packages: ['packages/*', 'packages/*/*'],
        catalog: {
          typescript: catalog['typescript'],
          '@types/bun': catalog['@types/bun'],
          '@zgeoff/bun-test-extended': catalog['@zgeoff/bun-test-extended'],
        },
      },
      devDependencies: {
        typescript: 'catalog:',
        '@types/bun': 'catalog:',
        '@zgeoff/bun-test-extended': 'catalog:',
      },
    }),
  );

  await Bun.write(join(ctx.directory, 'bunfig.toml'), '[install]\nlinker = "isolated"\n');

  await Bun.write(
    join(ctx.directory, 'tsconfig.base.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2024',
        module: 'Preserve',
        moduleResolution: 'bundler',
        skipLibCheck: true,
        noEmit: true,
      },
    }),
  );

  await Bun.write(
    join(ctx.directory, 'scripts/with-test-home.sh'),
    Bun.file(join(ctx.repo, 'scripts/with-test-home.sh')),
  );

  await Bun.write(join(ctx.directory, 'mods/README.md'), '# mods\n');

  await Bun.write(
    join(ctx.directory, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/test-utils/src/index.ts'),
    "export const FIXTURE = 'fixture';\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/harnesses/demo/package.json'),
    JSON.stringify({ name: '@atc/harness-demo', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.directory, 'packages/harnesses/demo/src/index.ts'),
    "export const DEMO = 'demo';\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/harnesses/demo/src/index.test.ts'),
    "import { expect, test } from 'bun:test';\nimport { DEMO } from './index';\n\ntest('it names the demo', () => {\n  expect(DEMO).toBe('demo');\n});\n",
  );

  createStubBin(
    join(ctx.directory, 'bin'),
    'node',
    "#!/bin/sh\necho 'node: not usable here' >&2\nexit 1\n",
  );

  const ran = await runCommand(
    [process.execPath, join(import.meta.dir, 'test-plugin.ts'), 'harness-demo', ctx.directory],
    { env: { ...process.env, PATH: `${join(ctx.directory, 'bin')}:${process.env['PATH']}` } },
  );

  expect(ran.stdout).toInclude('test-plugin: harness-demo passed in a workspace without the app');
  expect(ran.exitCode).toBe(0);
});
