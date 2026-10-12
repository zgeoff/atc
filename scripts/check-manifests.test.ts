import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand } from '../packages/app/src/test-utils/run-command';
import { setupTempDir } from '../packages/app/src/test-utils/setup-temp-dir';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('check-manifests-');

  return { dir: tmp.dir };
}

test('it passes packages whose manifests declare what their files import', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({
      name: '@atc/tui',
      dependencies: { '@atc/core': 'workspace:*', zod: 'catalog:' },
      devDependencies: { '@faker-js/faker': 'catalog:' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/src/render.ts'),
    "import { z } from 'zod';\nimport { isRecord } from '@atc/core';\nimport { join } from 'node:path';\nimport { $ } from 'bun';\nimport { WIDTH } from './width';\n\nexport const RENDER = [z, isRecord, join, $, WIDTH];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/src/render.test.ts'),
    "import { faker } from '@faker-js/faker';\n\nexport const NAME = faker;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-manifests: 2 packages, 2 files, 0 findings\n',
    stderr: '',
  });
});

test('it fails on a relative import into another package', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(join(ctx.dir, 'packages/tui/package.json'), JSON.stringify({ name: '@atc/tui' }));

  await Bun.write(
    join(ctx.dir, 'packages/daemon/package.json'),
    JSON.stringify({ name: '@atc/daemon' }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/sessions.ts'),
    'export const SESSIONS = [];\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/src/a.ts'),
    "import { SESSIONS } from '../../daemon/src/sessions';\n\nexport const A = SESSIONS;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-manifests: 3 packages, 2 files, 1 findings\n',
    stderr:
      'outside package: packages/tui/src/a.ts imports ../../daemon/src/sessions, which resolves into packages/daemon\n',
  });
});

test('it fails on a literal dynamic import into another package', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(join(ctx.dir, 'packages/mcp/package.json'), JSON.stringify({ name: '@atc/mcp' }));

  await Bun.write(
    join(ctx.dir, 'packages/mcp/src/a.ts'),
    "export const LOADED = await import('../../store/src/open-store');\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-manifests: 2 packages, 1 files, 1 findings\n',
    stderr:
      'outside package: packages/mcp/src/a.ts imports ../../store/src/open-store, which resolves into the root package\n',
  });
});

test('it fails on a bare import the manifest does not declare', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({ name: '@atc/tui', dependencies: { '@atc/protocol': 'workspace:*' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/src/a.ts'),
    "import type { SessionID } from '@atc/core/ids';\n\nexport type A = SessionID;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-manifests: 2 packages, 1 files, 1 findings\n',
    stderr:
      'undeclared: packages/tui/src/a.ts imports @atc/core, which packages/tui/package.json does not declare\n',
  });
});

test('it fails on a production file importing a dev dependency', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/store/package.json'),
    JSON.stringify({ name: '@atc/store', devDependencies: { 'tiny-invariant': 'catalog:' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/store/src/a.ts'),
    "import invariant from 'tiny-invariant';\n\nexport const A = invariant;\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/store/src/testing/b.ts'),
    "import invariant from 'tiny-invariant';\n\nexport const B = invariant;\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-manifests: 2 packages, 2 files, 1 findings\n',
    stderr:
      'dev dependency: packages/store/src/a.ts imports tiny-invariant, which packages/store/package.json declares only for tests\n',
  });
});

test('it fails on manifest entries that are not workspace or catalog references', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({
      name: 'root',
      workspaces: { packages: ['packages/*'] },
      devDependencies: { oxlint: '1.73.0' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/store/package.json'),
    JSON.stringify({ name: '@atc/store', dependencies: { '@atc/core': '^0.1.0' } }),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-manifests: 2 packages, 0 files, 2 findings\n',
    stderr:
      'manifest entry: package.json devDependencies has oxlint at 1.73.0, not catalog:\nmanifest entry: packages/store/package.json dependencies has @atc/core at ^0.1.0, not workspace:*\n',
  });
});

test('it fails on a dependency outside the package row', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({ name: '@atc/tui', dependencies: { '@atc/lifecycle': 'workspace:*' } }),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-manifests: 2 packages, 0 files, 1 findings\n',
    stderr:
      "package rule: packages/tui/package.json depends on @atc/lifecycle, outside @atc/tui's row\n",
  });
});

test('it fails on a package with no row or a name its row does not give', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/extras/package.json'),
    JSON.stringify({ name: '@atc/extras' }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({ name: '@atc/terminal' }),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-manifests: 3 packages, 0 files, 2 findings\n',
    stderr:
      'unknown package: packages/extras has no row in the package rules\npackage name: packages/tui/package.json is named @atc/terminal, not @atc/tui\n',
  });
});

test('it lets the root reach the app by path and nothing else', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(join(ctx.dir, 'packages/app/package.json'), JSON.stringify({ name: '@atc/app' }));
  await Bun.write(join(ctx.dir, 'packages/tui/package.json'), JSON.stringify({ name: '@atc/tui' }));

  await Bun.write(
    join(ctx.dir, 'e2e/journey.test.ts'),
    "import { waitFor } from '../packages/app/src/test-utils/wait-for';\nimport { render } from '../packages/tui/src/render';\n\nexport const JOURNEY = [waitFor, render];\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-manifests: 3 packages, 1 files, 1 findings\n',
    stderr:
      'outside package: e2e/journey.test.ts imports ../packages/tui/src/render, which resolves into packages/tui\n',
  });
});

test('it ignores a package named only to resolve a path', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'scripts/probe.ts'),
    "export const PATH = Bun.resolveSync('bun-pty/package.json', import.meta.dir);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-manifests: 1 packages, 1 files, 0 findings\n',
    stderr: '',
  });
});
