import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { z } from 'zod';

// A temp directory standing in for a repo root, and the real repo, whose
// test-home script and tool versions the stand-in reuses
function setupTest() {
  const tmp = setupTempDir('test-plugin-');

  return { dir: tmp.dir, repo: join(import.meta.dir, '..') };
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
    join(ctx.dir, 'package.json'),
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

  await Bun.write(join(ctx.dir, 'bunfig.toml'), '[install]\nlinker = "isolated"\n');

  await Bun.write(
    join(ctx.dir, 'tsconfig.base.json'),
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
    join(ctx.dir, 'scripts/with-test-home.sh'),
    Bun.file(join(ctx.repo, 'scripts/with-test-home.sh')),
  );

  await Bun.write(join(ctx.dir, 'mods/README.md'), '# mods\n');

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({ name: '@atc/core', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(join(ctx.dir, 'packages/core/src/index.ts'), "export const CORE = 'core';\n");

  await Bun.write(
    join(ctx.dir, 'packages/plugin-api/package.json'),
    JSON.stringify({
      name: '@atc/plugin-api',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/core': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/plugin-api/src/index.ts'),
    "import { CORE } from '@atc/core';\n\nexport const API = [CORE, 'api'].join('-');\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/store/package.json'),
    JSON.stringify({ name: '@atc/store', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(join(ctx.dir, 'packages/store/src/index.ts'), "export const STORE = 'store';\n");

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/index.ts'),
    "export const FIXTURE = 'fixture';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/harnesses/demo/package.json'),
    JSON.stringify({
      name: '@atc/harness-demo',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/plugin-api': 'workspace:*' },
      devDependencies: { '@atc/test-utils': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/harnesses/demo/src/index.ts'),
    "import { API } from '@atc/plugin-api';\n\nexport const DEMO = [API, 'demo'].join('-');\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/harnesses/demo/src/index.test.ts'),
    "import { expect, test } from 'bun:test';\nimport { FIXTURE } from '@atc/test-utils';\nimport { DEMO } from './index';\n\ntest('it builds the name', () => {\n  expect([DEMO, FIXTURE]).toStrictEqual(['core-api-demo', 'fixture']);\n});\n",
  );

  const ran = await runCommand([
    process.execPath,
    join(import.meta.dir, 'test-plugin.ts'),
    'harness-demo',
    ctx.dir,
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
    ['core', 'plugin-api', 'test-utils', 'harnesses/demo', 'store'].map((dir) =>
      existsSync(join(kept, 'packages', dir, 'package.json')),
    ),
  ).toStrictEqual([true, true, true, true, false]);

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
}, 300_000);
