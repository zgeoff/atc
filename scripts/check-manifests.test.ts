import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

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
      exports: { '.': './src/index.ts' },
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

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({ name: '@atc/tui', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/daemon/package.json'),
    JSON.stringify({ name: '@atc/daemon', exports: { '.': './src/index.ts' } }),
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

test('it fails on a module load whose specifier is a template literal', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({ name: '@atc/core', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/src/a.ts'),
    'export const FS = await import(`node:fs`);\n',
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
      'computed specifier: packages/core/src/a.ts:1 references a module through a specifier that no import rule can read; quote it\n',
  });
});

test('it fails on a module load or a resolve form whose specifier is computed', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/package.json'),
    JSON.stringify({ name: '@atc/app', exports: {} }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/store/rows.ts'),
    [
      "const name = '../daemon/ids';",
      'export const A = await import(name);',
      'export const B = require(name);',
      'export const C = import.meta.resolve(name);',
      'export const D = Bun.resolveSync(name, import.meta.dir);',
      'export const E = new URL(name, import.meta.url);',
      '',
    ].join('\n'),
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
    stdout: 'check-manifests: 2 packages, 1 files, 5 findings\n',
    stderr: [
      'computed specifier: packages/app/src/store/rows.ts:2 references a module through a specifier that no import rule can read; quote it',
      'computed specifier: packages/app/src/store/rows.ts:3 references a module through a specifier that no import rule can read; quote it',
      'computed specifier: packages/app/src/store/rows.ts:4 references a module through a specifier that no import rule can read; quote it',
      'computed specifier: packages/app/src/store/rows.ts:5 references a module through a specifier that no import rule can read; quote it',
      'computed specifier: packages/app/src/store/rows.ts:6 references a module through a specifier that no import rule can read; quote it',
      '',
    ].join('\n'),
  });
});

test('it lets the root package resolve a computed specifier and never load one', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'scripts/bundle.ts'),
    "const name = './plugin';\nexport const PATH = Bun.resolveSync(name, import.meta.dir);\nexport const PLUGIN = await import(name);\n",
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
    stdout: 'check-manifests: 1 packages, 1 files, 1 findings\n',
    stderr:
      'computed specifier: scripts/bundle.ts:3 references a module through a specifier that no import rule can read; quote it\n',
  });
});

test('it lets a listed helper test reach the app and no other helper test', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/package.json'),
    JSON.stringify({ name: '@atc/app', exports: {} }),
  );

  await Bun.write(join(ctx.dir, 'packages/app/src/keymap.ts'), 'export const KEYMAP = [];\n');

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/keys.test.ts'),
    "import { KEYMAP } from '../../app/src/keymap';\n\nexport const A = KEYMAP;\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/wait-for.test.ts'),
    "import { KEYMAP } from '../../app/src/keymap';\n\nexport const B = KEYMAP;\n",
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
    stdout: 'check-manifests: 3 packages, 3 files, 1 findings\n',
    stderr:
      'outside package: packages/test-utils/src/wait-for.test.ts imports ../../app/src/keymap, which resolves into packages/app\n',
  });
});

test('it fails on a literal dynamic import into another package', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/mcp/package.json'),
    JSON.stringify({ name: '@atc/mcp', exports: { '.': './src/index.ts' } }),
  );

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
    JSON.stringify({
      name: '@atc/tui',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/protocol': 'workspace:*' },
    }),
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
    JSON.stringify({
      name: '@atc/store',
      exports: { '.': './src/index.ts' },
      devDependencies: { 'tiny-invariant': 'catalog:' },
    }),
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
    JSON.stringify({
      name: '@atc/store',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/core': '^0.1.0' },
    }),
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
    JSON.stringify({
      name: '@atc/tui',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/lifecycle': 'workspace:*' },
    }),
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
    JSON.stringify({ name: '@atc/extras', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({ name: '@atc/terminal', exports: { '.': './src/index.ts' } }),
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

  await Bun.write(
    join(ctx.dir, 'packages/app/package.json'),
    JSON.stringify({ name: '@atc/app', exports: {} }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({ name: '@atc/tui', exports: { '.': './src/index.ts' } }),
  );

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

test('it passes imports of a package root and of a named entry point', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({ name: '@atc/core', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/protocol/package.json'),
    JSON.stringify({
      name: '@atc/protocol',
      exports: { '.': './src/index.ts', './wire': './src/wire/index.ts' },
      dependencies: { '@atc/core': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({
      name: '@atc/tui',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/core': 'workspace:*', '@atc/protocol': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/src/a.ts'),
    "import { isRecord } from '@atc/core';\nimport { DaemonClient } from '@atc/protocol/wire';\n\nexport const A = [isRecord, DaemonClient];\n",
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
    stdout: 'check-manifests: 4 packages, 1 files, 0 findings\n',
    stderr: '',
  });
});

test('it leaves a subpath the exports map does not list to the import lint rules', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({ name: '@atc/core', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({
      name: '@atc/tui',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/core': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/src/a.ts'),
    "import { isRecord } from '@atc/core/is-record';\n\nexport const A = isRecord;\n",
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
    stdout: 'check-manifests: 3 packages, 1 files, 0 findings\n',
    stderr: '',
  });
});

test('it fails on a package with no exports map or a wildcard entry', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({ name: '@atc/core' }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/protocol/package.json'),
    JSON.stringify({
      name: '@atc/protocol',
      exports: { '.': './src/index.ts', './*': './src/*.ts' },
    }),
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
      'no exports: packages/core/package.json holds no exports map\nwildcard entry: packages/protocol/package.json exports ./*, which makes every matching file public; list each entry point\n',
  });
});
