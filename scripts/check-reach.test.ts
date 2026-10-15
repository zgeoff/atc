import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('check-reach-');

  return { dir: tmp.dir };
}

test('it passes a gateway that reaches only what its allowance holds', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\nsrc/run-gateway.ts\tapp\tpackages/app/src/run-gateway.ts\nsrc/shared/bun-sqlite-driver.ts\tstore\tpackages/app/src/shared/bun-sqlite-driver.ts\nsrc/protocol/features.ts\t(deleted in ticket 24)\tpackages/app/src/protocol/features.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\nsrc/run-gateway.ts\tapp\tcli\nsrc/shared/bun-sqlite-driver.ts\tstore\tsqlite\nsrc/protocol/features.ts\t(deleted in ticket 24)\t\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/interim.json'),
    JSON.stringify({ 'src/protocol/features.ts': 'protocol' }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/shared/bun-sqlite-driver.ts'),
    'export const DRIVER = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/protocol/features.ts'),
    'export const FEATURES = [];\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/run-gateway.ts'),
    "import { DRIVER } from './shared/bun-sqlite-driver';\nimport { FEATURES } from './protocol/features';\n\nexport const GATEWAY = [DRIVER, FEATURES];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { GATEWAY } from './run-gateway';\n\nconsole.log(GATEWAY);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-reach: 4 files reached, 4 bundled, 0 findings\n',
    stderr: '',
  });
});

test('it fails on a gateway that reaches the daemon through an allowed module', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\nsrc/mcp/run-tool.ts\tmcp\tpackages/app/src/mcp/run-tool.ts\nsrc/daemon/sessions.ts\tdaemon\tpackages/app/src/daemon/sessions.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\nsrc/mcp/run-tool.ts\tmcp\ttools\nsrc/daemon/sessions.ts\tdaemon\tsessions\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/daemon/sessions.ts'),
    'export const SESSIONS = [];\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/mcp/run-tool.ts'),
    "import { SESSIONS } from '../daemon/sessions';\n\nexport const TOOL = SESSIONS;\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "const tool = await import('./mcp/run-tool');\n\nconsole.log(tool.TOOL);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-reach: 3 files reached, 3 bundled, 2 findings\n',
    stderr:
      'unreachable module: packages/app/src/gateway.ts reaches packages/app/src/daemon/sessions.ts (daemon)\nunreachable module: packages/app/src/gateway.ts bundles packages/app/src/daemon/sessions.ts (daemon)\n',
  });
});

test('it fails on a gateway that reaches a daemon module written as .mjs', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\nsrc/daemon/start.mjs\tdaemon\tpackages/app/src/daemon/start.mjs\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\nsrc/daemon/start.mjs\tdaemon\t\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');
  await Bun.write(join(ctx.dir, 'packages/app/src/daemon/start.mjs'), 'export const START = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { START } from './daemon/start.mjs';\n\nconsole.log(START);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-reach: 2 files reached, 2 bundled, 2 findings\n',
    stderr:
      'unreachable module: packages/app/src/gateway.ts reaches packages/app/src/daemon/start.mjs (daemon)\nunreachable module: packages/app/src/gateway.ts bundles packages/app/src/daemon/start.mjs (daemon)\n',
  });
});

test('it fails on a type-only reach that the bundle drops', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\nsrc/client/index.ts\ttui\tpackages/app/src/client/index.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\nsrc/client/index.ts\ttui\t\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/client/index.ts'),
    'export interface Screen {}\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import type { Screen } from './client/index';\n\nconst screens: Screen[] = [];\n\nconsole.log(screens);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-reach: 2 files reached, 1 bundled, 1 findings\n',
    stderr:
      'unreachable module: packages/app/src/gateway.ts reaches packages/app/src/client/index.ts (tui)\n',
  });
});

test('it fails on a reached module with no row in the package map', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/shared/new-helper.ts'),
    'export const HELPER = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { HELPER } from './shared/new-helper';\n\nconsole.log(HELPER);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-reach: 2 files reached, 2 bundled, 2 findings\n',
    stderr:
      'unmapped module: packages/app/src/gateway.ts reaches packages/app/src/shared/new-helper.ts, which has no row in the package map\nunmapped module: packages/app/src/gateway.ts bundles packages/app/src/shared/new-helper.ts, which has no row in the package map\n',
  });
});

test('it follows a workspace package import through a wildcard export', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\tpath_wave3\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\tpackages/app/src/gateway.ts\nsrc/client/boot-daemon.ts\tlifecycle\tpackages/app/src/client/boot-daemon.ts\tpackages/lifecycle/src/boot/boot-daemon.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\nsrc/client/boot-daemon.ts\tlifecycle\t\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');

  await Bun.write(
    join(ctx.dir, 'packages/lifecycle/package.json'),
    JSON.stringify({ name: '@atc/lifecycle', exports: { './*': './src/*.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/lifecycle/src/boot/boot-daemon.ts'),
    'export const BOOT = 1;\n',
  );

  mkdirSync(join(ctx.dir, 'node_modules/@atc'), { recursive: true });
  symlinkSync(join(ctx.dir, 'packages/lifecycle'), join(ctx.dir, 'node_modules/@atc/lifecycle'));

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { BOOT } from '@atc/lifecycle/boot/boot-daemon';\n\nconsole.log(BOOT);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-reach: 2 files reached, 2 bundled, 2 findings\n',
    stderr:
      'unreachable module: packages/app/src/gateway.ts reaches packages/lifecycle/src/boot/boot-daemon.ts (lifecycle)\nunreachable module: packages/app/src/gateway.ts bundles packages/lifecycle/src/boot/boot-daemon.ts (lifecycle)\n',
  });
});

test('it follows a workspace package import through the package exports', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\tpath_wave4\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\tpackages/app/src/gateway.ts\nsrc/client/boot-daemon.ts\tlifecycle\tpackages/app/src/client/boot-daemon.ts\tpackages/lifecycle/src/boot-daemon.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\nsrc/client/boot-daemon.ts\tlifecycle\t\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');

  await Bun.write(
    join(ctx.dir, 'packages/lifecycle/package.json'),
    JSON.stringify({ name: '@atc/lifecycle', exports: { '.': './src/boot-daemon.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/lifecycle/src/boot-daemon.ts'),
    'export const BOOT = 1;\n',
  );

  mkdirSync(join(ctx.dir, 'node_modules/@atc'), { recursive: true });
  symlinkSync(join(ctx.dir, 'packages/lifecycle'), join(ctx.dir, 'node_modules/@atc/lifecycle'));

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { BOOT } from '@atc/lifecycle';\n\nconsole.log(BOOT);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-reach: 2 files reached, 2 bundled, 2 findings\n',
    stderr:
      'unreachable module: packages/app/src/gateway.ts reaches packages/lifecycle/src/boot-daemon.ts (lifecycle)\nunreachable module: packages/app/src/gateway.ts bundles packages/lifecycle/src/boot-daemon.ts (lifecycle)\n',
  });
});

test('it follows a workspace package import through a named entry point', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\npackages/store/src/sqlite/index.ts\tstore\tpackages/store/src/sqlite/index.ts\npackages/store/src/sqlite/open-sqlite.ts\tstore\tpackages/store/src/sqlite/open-sqlite.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\npackages/store/src/sqlite/index.ts\tstore\tsqlite\npackages/store/src/sqlite/open-sqlite.ts\tstore\tsqlite\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');

  await Bun.write(
    join(ctx.dir, 'packages/store/package.json'),
    JSON.stringify({
      name: '@atc/store',
      exports: { '.': './src/index.ts', './sqlite': './src/sqlite/index.ts' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/store/src/sqlite/index.ts'),
    "export * from './open-sqlite';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/store/src/sqlite/open-sqlite.ts'),
    'export const OPEN = 1;\n',
  );

  mkdirSync(join(ctx.dir, 'node_modules/@atc'), { recursive: true });
  symlinkSync(join(ctx.dir, 'packages/store'), join(ctx.dir, 'node_modules/@atc/store'));

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { OPEN } from '@atc/store/sqlite';\n\nconsole.log(OPEN);\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-reach: 3 files reached, 3 bundled, 0 findings\n',
    stderr: '',
  });
});

test('it passes reporters whose static imports load only light entry points', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');
  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/protocol/package.json'),
    JSON.stringify({
      name: '@atc/protocol',
      exports: { '.': './src/index.ts', './session': './src/session/index.ts' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/protocol/src/index.ts'),
    "export * from './schemas';\nexport * from './session';\n",
  );

  await Bun.write(join(ctx.dir, 'packages/protocol/src/schemas.ts'), 'export const SCHEMA = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/protocol/src/session/index.ts'),
    "export * from './read-session-env';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/protocol/src/session/read-session-env.ts'),
    'export const ENV = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import type { SCHEMA } from '@atc/protocol';\nimport { ENV } from '@atc/protocol/session';\n\nconst schemas = await import('@atc/protocol');\n\nexport const CLI: [typeof SCHEMA, number, unknown] = [1, ENV, schemas];\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/hook-report.ts'),
    "import { ENV } from '@atc/protocol/session';\n\nexport const REPORT = ENV;\n",
  );

  await Bun.write(join(ctx.dir, 'packages/app/src/note.ts'), 'export const NOTE = 1;\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/tap.ts'), 'export const TAP = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/run-bridge-tap.ts'),
    'export const BRIDGE_TAP = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/statusline.ts'),
    'export const STATUSLINE = 1;\n',
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-reach: 1 files reached, 1 bundled, 0 findings\n',
    stderr: '',
  });
});

test('it fails on a reporter whose static imports load a root entry point', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');
  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/protocol/package.json'),
    JSON.stringify({
      name: '@atc/protocol',
      exports: { '.': './src/index.ts', './session': './src/session/index.ts' },
    }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/protocol/src/index.ts'),
    "export * from './schemas';\nexport * from './session';\n",
  );

  await Bun.write(join(ctx.dir, 'packages/protocol/src/schemas.ts'), 'export const SCHEMA = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/protocol/src/session/index.ts'),
    "export * from './read-session-env';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/protocol/src/session/read-session-env.ts'),
    'export const ENV = 1;\n',
  );

  await Bun.write(join(ctx.dir, 'packages/app/src/cli.ts'), 'export const CLI = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/hook-report.ts'),
    "import { ENV } from '@atc/protocol';\n\nexport const REPORT = ENV;\n",
  );

  await Bun.write(join(ctx.dir, 'packages/app/src/note.ts'), 'export const NOTE = 1;\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/tap.ts'), 'export const TAP = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/run-bridge-tap.ts'),
    'export const BRIDGE_TAP = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/statusline.ts'),
    'export const STATUSLINE = 1;\n',
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-reach: 1 files reached, 1 bundled, 2 findings\n',
    stderr:
      'slow reporter: packages/app/src/hook-report.ts loads packages/protocol/src/index.ts at start-up, outside the entries a reporter may load\nslow reporter: packages/app/src/hook-report.ts loads packages/protocol/src/schemas.ts at start-up, outside the entries a reporter may load\n',
  });
});

test('it fails on a CLI entry whose static imports load the core schema entry', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');
  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({
      name: '@atc/core',
      exports: { '.': './src/index.ts', './schema': './src/schema/index.ts' },
    }),
  );

  await Bun.write(join(ctx.dir, 'packages/core/src/index.ts'), "export * from './is-error';\n");
  await Bun.write(join(ctx.dir, 'packages/core/src/is-error.ts'), 'export const IS_ERROR = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/core/src/schema/index.ts'),
    "export * from './build-optional-boolean';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/core/src/schema/build-optional-boolean.ts'),
    'export const buildOptionalBoolean = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/cli.ts'),
    "import { buildOptionalBoolean } from '@atc/core/schema';\n\nexport const CLI = buildOptionalBoolean;\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/hook-report.ts'),
    "import { IS_ERROR } from '@atc/core';\n\nexport const REPORT = IS_ERROR;\n",
  );

  await Bun.write(join(ctx.dir, 'packages/app/src/note.ts'), 'export const NOTE = 1;\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/tap.ts'), 'export const TAP = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/run-bridge-tap.ts'),
    'export const BRIDGE_TAP = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/statusline.ts'),
    'export const STATUSLINE = 1;\n',
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-reach: 1 files reached, 1 bundled, 2 findings\n',
    stderr:
      'slow reporter: packages/app/src/cli.ts loads packages/core/src/schema/build-optional-boolean.ts at start-up, outside the entries a reporter may load\nslow reporter: packages/app/src/cli.ts loads packages/core/src/schema/index.ts at start-up, outside the entries a reporter may load\n',
  });
});

test('it fails on a missing reporter entry beside the CLI entry', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/gateway.ts\tapp\tpackages/app/src/gateway.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-filemap.tsv'),
    'source\tpackage\tfolder\nsrc/gateway.ts\tapp\t\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/interim.json'), '{}');
  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/cli.ts'), 'export const CLI = 1;\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/hook-report.ts'), 'export const REPORT = 1;\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/note.ts'), 'export const NOTE = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/run-bridge-tap.ts'),
    'export const BRIDGE_TAP = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/statusline.ts'),
    'export const STATUSLINE = 1;\n',
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-reach.ts'),
    ctx.dir,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-reach: 1 files reached, 1 bundled, 1 findings\n',
    stderr: 'missing reporter: packages/app/src/tap.ts does not exist\n',
  });
});
