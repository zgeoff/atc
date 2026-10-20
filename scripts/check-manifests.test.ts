import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('check-manifests-');

  return { dir: tmp.path };
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

test('it fails on a mod that loads a module through a template literal', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'mods/bridge/hooks/register.ts'),
    'export const CLIENT: unknown = await import(`@impz/client`);\n',
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
      'computed specifier: mods/bridge/hooks/register.ts:1 references a module through a specifier that no import rule can read; quote it\n',
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

test('it fails on a root catalog entry or root devDependency that is not exact', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({
      name: 'root',
      workspaces: {
        packages: ['packages/*'],
        catalog: {
          '@types/bun': '1.4.2',
          '@impz/client': '0.3.0-beta.1',
          '@demo/lint-next': 'npm:@demo/lint@2.1.0',
          '@demo/lint-range': 'npm:@demo/lint@^2.1.0',
          gunshi: '*',
          knip: '^6.24.0',
          kysely: '>=0.29.5',
          oxfmt: '~0.57.0',
          oxlint: '1.73.0',
          tslib: '',
          'type-fest': 'latest',
          zod: '4.6.x',
        },
      },
      devDependencies: { knip: 'catalog:', oxfmt: 'catalog:', oxlint: '^1.73.0' },
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
    stdout: 'check-manifests: 1 packages, 0 files, 9 findings\n',
    stderr:
      'manifest entry: package.json devDependencies has oxlint at ^1.73.0, not catalog:\ncatalog range: package.json catalog has @demo/lint-range at npm:@demo/lint@^2.1.0, not an exact version\ncatalog range: package.json catalog has gunshi at *, not an exact version\ncatalog range: package.json catalog has knip at ^6.24.0, not an exact version\ncatalog range: package.json catalog has kysely at >=0.29.5, not an exact version\ncatalog range: package.json catalog has oxfmt at ~0.57.0, not an exact version\ncatalog range: package.json catalog has tslib at , not an exact version\ncatalog range: package.json catalog has type-fest at latest, not an exact version\ncatalog range: package.json catalog has zod at 4.6.x, not an exact version\n',
  });
});

test('it fails on a package named outside the @atc/ scope', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/extras/package.json'),
    JSON.stringify({ name: 'extras', exports: { '.': './src/index.ts' } }),
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
    stdout: 'check-manifests: 3 packages, 0 files, 1 findings\n',
    stderr: 'package name: packages/extras/package.json is named extras, outside the @atc/ scope\n',
  });
});

test('it reads the committed zones table and refuses a dependency outside a package row', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*', 'packages/*/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, '.oxlintrc.zones.json'),
    Bun.file(join(import.meta.dir, '../.oxlintrc.zones.json')),
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({
      name: '@atc/core',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/protocol': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/protocol/package.json'),
    JSON.stringify({
      name: '@atc/protocol',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/core': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/harnesses/codex/package.json'),
    JSON.stringify({ name: '@atc/harness-codex', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/harnesses/grok/package.json'),
    JSON.stringify({
      name: '@atc/harness-grok',
      exports: { '.': './src/index.ts' },
      dependencies: { '@atc/core': 'workspace:*', '@atc/harness-codex': 'workspace:*' },
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
    stdout: 'check-manifests: 5 packages, 0 files, 2 findings\n',
    stderr:
      'package rule: packages/core/package.json depends on @atc/protocol, which the package-deps edge in .oxlintrc.zones.json refuses\npackage rule: packages/harnesses/grok/package.json depends on @atc/harness-codex, which the package-deps edge in .oxlintrc.zones.json refuses\n',
  });
});

test('it fails on a production dependency that an edge of the zones table refuses', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, '.oxlintrc.zones.json'),
    `{
  // the package boundaries
  "rules": {
    "zgeoff/import-zones": [
      "error",
      {
        "zones": {
          "packages": ["packages/**"],
          "core": ["packages/core{,/**}"],
          "lifecycle": ["packages/lifecycle{,/**}"],
          "tui": ["packages/tui{,/**}"],
          "test-utils": ["packages/test-utils{,/**}"]
        },
        "edges": [
          { "name": "package-deps", "from": ["tui"], "allow": ["core", "test-utils"] },
          {
            "name": "test-helpers",
            "from": ["packages"],
            "to": ["test-utils"],
            "ignore": ["**/*.test.ts"]
          }
        ]
      }
    ]
  }
}
`,
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({
      name: '@atc/core',
      exports: { '.': './src/index.ts' },
      devDependencies: { '@atc/test-utils': 'workspace:*' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/lifecycle/package.json'),
    JSON.stringify({ name: '@atc/lifecycle', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/tui/package.json'),
    JSON.stringify({
      name: '@atc/tui',
      exports: { '.': './src/index.ts' },
      dependencies: {
        '@atc/core': 'workspace:*',
        '@atc/lifecycle': 'workspace:*',
        '@atc/test-utils': 'workspace:*',
      },
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
    stdout: 'check-manifests: 5 packages, 0 files, 2 findings\n',
    stderr:
      'package rule: packages/tui/package.json depends on @atc/lifecycle, which the package-deps edge in .oxlintrc.zones.json refuses\npackage rule: packages/tui/package.json depends on @atc/test-utils, which the test-helpers edge in .oxlintrc.zones.json refuses\n',
  });
});

test.each([
  [
    'a key the rule does not know',
    { name: 'package-deps', from: ['tui'], allow: ['tui'], allowAlways: true },
  ],
  ['neither to nor allow', { name: 'package-deps', from: ['tui'] }],
  [
    'an option of the wrong type',
    { name: 'package-deps', from: ['tui'], allow: ['tui'], allowWithin: 3 },
  ],
])('it fails on a zones table with an edge that holds %s', async (_label, edge) => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, '.oxlintrc.zones.json'),
    JSON.stringify({
      rules: {
        'zgeoff/import-zones': [
          'error',
          {
            zones: { tui: ['packages/tui{,/**}'] },
            edges: [edge],
          },
        ],
      },
    }),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-manifests.ts'),
    ctx.dir,
  ]);

  expect(checked.exitCode).toBe(1);
  expect(checked.stderr).toInclude('"zgeoff/import-zones"');
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

test('it fails on an entry point that loads a preloaded module', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'bunfig.toml'),
    '[test]\npreload = ["./packages/test-utils/src/isolate-home.ts", "@zgeoff/bun-test-extended"]\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({
      name: '@atc/test-utils',
      exports: { '.': './src/index.ts', './home': './src/isolate-home.ts' },
      dependencies: { '@zgeoff/bun-test-extended': 'catalog:' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/index.ts'),
    "export * from './isolate-home';\nexport * from './wait-for';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/wait-for.ts'),
    "import '@zgeoff/bun-test-extended';\nimport { ROOT } from './isolate-home.ts';\n\nexport const WAIT = ROOT;\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/isolate-home.ts'),
    "export const ROOT = '/';\n",
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
    stdout: 'check-manifests: 2 packages, 3 files, 4 findings\n',
    stderr:
      'preloaded module: packages/test-utils/src/index.ts, which packages/test-utils/src/index.ts reaches as an entry point of packages/test-utils, loads ./isolate-home, which bunfig.toml preloads as ./packages/test-utils/src/isolate-home.ts; import it by path\n' +
      'preloaded module: packages/test-utils/src/wait-for.ts, which packages/test-utils/src/index.ts reaches as an entry point of packages/test-utils, loads @zgeoff/bun-test-extended, which bunfig.toml preloads as @zgeoff/bun-test-extended; import it by path\n' +
      'preloaded module: packages/test-utils/src/wait-for.ts, which packages/test-utils/src/index.ts reaches as an entry point of packages/test-utils, loads ./isolate-home.ts, which bunfig.toml preloads as ./packages/test-utils/src/isolate-home.ts; import it by path\n' +
      'preloaded entry: packages/test-utils/src/isolate-home.ts, an entry point of packages/test-utils, is ./packages/test-utils/src/isolate-home.ts, which bunfig.toml preloads; drop it from the exports map\n',
  });
});

test('it lets a test load a preloaded module that no entry point reaches', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'bunfig.toml'),
    '[test]\npreload = ["./packages/test-utils/src/isolate-home.ts"]\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/index.ts'),
    "import SCRIPT from './unpack.sh' with { type: 'text' };\n\nexport const UNPACK = SCRIPT;\n",
  );

  await Bun.write(join(ctx.dir, 'packages/test-utils/src/unpack.sh'), 'tar -x "$1"\n');

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/isolate-home.test.ts'),
    "import { ROOT } from './isolate-home';\n\nexport const HOME = ROOT;\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/isolate-home.ts'),
    "export const ROOT = '/';\n",
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
    stdout: 'check-manifests: 2 packages, 3 files, 0 findings\n',
    stderr: '',
  });
});

test('it lets an entry point name a preloaded module only through type-only specifiers', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'bunfig.toml'),
    '[test]\npreload = ["./packages/test-utils/src/isolate-home.ts"]\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/index.ts'),
    "export { type Home } from './isolate-home.ts';\nexport * from './wait-for';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/wait-for.ts'),
    "import { type Home } from './isolate-home.ts';\n\nexport const WAIT: Home | null = null;\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/isolate-home.ts'),
    "export type Home = { root: string };\nexport const startHome = () => '/';\n",
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
    stdout: 'check-manifests: 2 packages, 3 files, 0 findings\n',
    stderr: '',
  });
});

test('it fails on an entry point that names a preloaded module among a value and a type', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'bunfig.toml'),
    '[test]\npreload = ["./packages/test-utils/src/isolate-home.ts"]\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/index.ts'),
    "export { type Home, startHome } from './isolate-home.ts';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/isolate-home.ts'),
    "export type Home = { root: string };\nexport const startHome = () => '/';\n",
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
      'preloaded module: packages/test-utils/src/index.ts, which packages/test-utils/src/index.ts reaches as an entry point of packages/test-utils, loads ./isolate-home.ts, which bunfig.toml preloads as ./packages/test-utils/src/isolate-home.ts; import it by path\n',
  });
});

test('it resolves an extensionless preload the way bun does', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
  );

  await Bun.write(
    join(ctx.dir, 'bunfig.toml'),
    '[test]\npreload = ["./packages/test-utils/src/isolate-home"]\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({
      name: '@atc/test-utils',
      exports: { '.': './src/index.ts', './home': './src/isolate-home.ts' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/index.ts'),
    "export * from './isolate-home.ts';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/src/isolate-home.ts'),
    "export const ROOT = '/';\n",
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
    stdout: 'check-manifests: 2 packages, 2 files, 2 findings\n',
    stderr:
      'preloaded module: packages/test-utils/src/index.ts, which packages/test-utils/src/index.ts reaches as an entry point of packages/test-utils, loads ./isolate-home.ts, which bunfig.toml preloads as ./packages/test-utils/src/isolate-home; import it by path\n' +
      'preloaded entry: packages/test-utils/src/isolate-home.ts, an entry point of packages/test-utils, is ./packages/test-utils/src/isolate-home, which bunfig.toml preloads; drop it from the exports map\n',
  });
});
