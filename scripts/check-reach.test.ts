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

  await Bun.write(join(ctx.dir, 'packages/app/src/mcp/run-tool.ts'), 'export const TOOL = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/federation/daemon-pool.ts'),
    'export const POOL = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/run-gateway.ts'),
    "import { TOOL } from './mcp/run-tool';\nimport { POOL } from './federation/daemon-pool';\n\nexport const GATEWAY = [TOOL, POOL];\n",
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

test('it passes a gateway that reaches a new file in an allowed package with no package map', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/core/package.json'),
    JSON.stringify({ name: '@atc/core', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(join(ctx.dir, 'packages/core/src/index.ts'), "export * from './new-helper';\n");
  await Bun.write(join(ctx.dir, 'packages/core/src/new-helper.ts'), 'export const HELPER = 1;\n');

  mkdirSync(join(ctx.dir, 'node_modules/@atc'), { recursive: true });
  symlinkSync(join(ctx.dir, 'packages/core'), join(ctx.dir, 'node_modules/@atc/core'));

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { HELPER } from '@atc/core';\n\nconsole.log(HELPER);\n",
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

test('it fails on a gateway that reaches the daemon through an allowed module', async () => {
  const ctx = setupTest();

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
      'unreachable module: packages/app/src/gateway.ts reaches packages/app/src/daemon/sessions.ts (app)\nunreachable module: packages/app/src/gateway.ts bundles packages/app/src/daemon/sessions.ts (app)\n',
  });
});

test('it fails on a gateway that reaches a module in the daemon package', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/daemon/package.json'),
    JSON.stringify({ name: '@atc/daemon', exports: { '.': './src/index.ts' } }),
  );

  await Bun.write(join(ctx.dir, 'packages/daemon/src/index.ts'), 'export const DAEMON = 1;\n');

  mkdirSync(join(ctx.dir, 'node_modules/@atc'), { recursive: true });
  symlinkSync(join(ctx.dir, 'packages/daemon'), join(ctx.dir, 'node_modules/@atc/daemon'));

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { DAEMON } from '@atc/daemon';\n\nconsole.log(DAEMON);\n",
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
      'unreachable module: packages/app/src/gateway.ts reaches packages/daemon/src/index.ts (daemon)\nunreachable module: packages/app/src/gateway.ts bundles packages/daemon/src/index.ts (daemon)\n',
  });
});

test('it fails on a gateway that reaches a daemon module written as .mjs', async () => {
  const ctx = setupTest();

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
      'unreachable module: packages/app/src/gateway.ts reaches packages/app/src/daemon/start.mjs (app)\nunreachable module: packages/app/src/gateway.ts bundles packages/app/src/daemon/start.mjs (app)\n',
  });
});

test('it fails on a type-only reach that the bundle drops', async () => {
  const ctx = setupTest();

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
      'unreachable module: packages/app/src/gateway.ts reaches packages/app/src/client/index.ts (app)\n',
  });
});

test('it fails on a reached module outside every package src/ folder', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/unlisted/new-helper.ts'), 'export const HELPER = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { HELPER } from '../../unlisted/new-helper';\n\nconsole.log(HELPER);\n",
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
      "unowned module: packages/app/src/gateway.ts reaches packages/unlisted/new-helper.ts, which sits in no package's src/ folder\nunowned module: packages/app/src/gateway.ts bundles packages/unlisted/new-helper.ts, which sits in no package's src/ folder\n",
  });
});

test('it fails on a reached module in a package outside the allowance', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/harnesses/claude/src/new-helper.ts'),
    'export const HELPER = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { HELPER } from '../../harnesses/claude/src/new-helper';\n\nconsole.log(HELPER);\n",
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
      'unreachable module: packages/app/src/gateway.ts reaches packages/harnesses/claude/src/new-helper.ts (harnesses/claude)\nunreachable module: packages/app/src/gateway.ts bundles packages/harnesses/claude/src/new-helper.ts (harnesses/claude)\n',
  });
});

test('it follows a workspace package import through a wildcard export', async () => {
  const ctx = setupTest();

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

test('it fails on a gateway that reaches the store outside its sqlite folder', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'packages/store/package.json'),
    JSON.stringify({
      name: '@atc/store',
      exports: { '.': './src/index.ts', './sqlite': './src/sqlite/index.ts' },
    }),
  );

  await Bun.write(join(ctx.dir, 'packages/store/src/index.ts'), 'export const STORE = 1;\n');

  mkdirSync(join(ctx.dir, 'node_modules/@atc'), { recursive: true });
  symlinkSync(join(ctx.dir, 'packages/store'), join(ctx.dir, 'node_modules/@atc/store'));

  await Bun.write(
    join(ctx.dir, 'packages/app/src/gateway.ts'),
    "import { STORE } from '@atc/store';\n\nconsole.log(STORE);\n",
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
      'unreachable module: packages/app/src/gateway.ts reaches packages/store/src/index.ts (store)\nunreachable module: packages/app/src/gateway.ts bundles packages/store/src/index.ts (store)\n',
  });
});

test('it passes reporters whose static imports load only light entry points', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');
  await Bun.write(join(ctx.dir, 'packages/daemon/src/index.ts'), 'export const DAEMON = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/testing/index.ts'),
    'export const STUB = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/open-mcp-auth-database.ts'),
    'export const OPEN = 1;\n',
  );

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

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');
  await Bun.write(join(ctx.dir, 'packages/daemon/src/index.ts'), 'export const DAEMON = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/testing/index.ts'),
    'export const STUB = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/open-mcp-auth-database.ts'),
    'export const OPEN = 1;\n',
  );

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

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');
  await Bun.write(join(ctx.dir, 'packages/daemon/src/index.ts'), 'export const DAEMON = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/testing/index.ts'),
    'export const STUB = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/open-mcp-auth-database.ts'),
    'export const OPEN = 1;\n',
  );

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

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');
  await Bun.write(join(ctx.dir, 'packages/daemon/src/index.ts'), 'export const DAEMON = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/testing/index.ts'),
    'export const STUB = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/open-mcp-auth-database.ts'),
    'export const OPEN = 1;\n',
  );

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

test('it passes a daemon entry that never reaches the mcp-auth.db opener', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/open-mcp-auth-database.ts'),
    'export const OPEN = 1;\n',
  );

  await Bun.write(join(ctx.dir, 'packages/daemon/src/serve.ts'), 'export const SERVE = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/index.ts'),
    "export { SERVE } from './serve';\n",
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

test('it fails on a daemon entry that reaches the mcp-auth.db opener through a dynamic import', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/open-mcp-auth-database.ts'),
    'export const OPEN = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/serve.ts'),
    "export const SERVE = () => import('../../app/src/open-mcp-auth-database');\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/index.ts'),
    "export { SERVE } from './serve';\n",
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
    stderr:
      "refused module: packages/daemon/src/index.ts reaches packages/app/src/open-mcp-auth-database.ts, which opens the gateway's mcp-auth.db\n",
  });
});

test('it fails on a missing daemon entry beside the CLI entry', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/cli.ts'), 'export const CLI = 1;\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/hook-report.ts'), 'export const REPORT = 1;\n');
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

  await Bun.write(
    join(ctx.dir, 'packages/app/src/open-mcp-auth-database.ts'),
    'export const OPEN = 1;\n',
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
      'missing daemon module: packages/daemon/src/index.ts does not exist\nmissing daemon module: packages/daemon/src/testing/index.ts does not exist\n',
  });
});

test('it fails on a missing mcp-auth.db opener beside the CLI entry', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/cli.ts'), 'export const CLI = 1;\n');
  await Bun.write(join(ctx.dir, 'packages/app/src/hook-report.ts'), 'export const REPORT = 1;\n');
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

  await Bun.write(join(ctx.dir, 'packages/daemon/src/index.ts'), 'export const DAEMON = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/testing/index.ts'),
    'export const STUB = 1;\n',
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
    stderr: 'missing daemon module: packages/app/src/open-mcp-auth-database.ts does not exist\n',
  });
});

test('it fails on a daemon entry that reaches the mcp-auth.db opener through a type-only import', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/open-mcp-auth-database.ts'),
    'export type Open = number;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/index.ts'),
    "export type { Open } from '../../app/src/open-mcp-auth-database';\n",
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
    stderr:
      "refused module: packages/daemon/src/index.ts reaches packages/app/src/open-mcp-auth-database.ts, which opens the gateway's mcp-auth.db\n",
  });
});

test('it fails on a daemon testing entry that reaches the mcp-auth.db opener', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/open-mcp-auth-database.ts'),
    'export const OPEN = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/testing/index.ts'),
    "export { OPEN } from '../../../app/src/open-mcp-auth-database';\n",
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
    stderr:
      "refused module: packages/daemon/src/testing/index.ts reaches packages/app/src/open-mcp-auth-database.ts, which opens the gateway's mcp-auth.db\n",
  });
});

test('it fails on a daemon module that opens mcp-auth.db by its file name', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/serve.ts'),
    "import { join } from 'node:path';\n\nexport const SERVE = (dir: string) => join(dir, 'mcp-auth.db');\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/index.ts'),
    "export { SERVE } from './serve';\n",
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
    stderr:
      "named database: packages/daemon/src/index.ts reaches packages/daemon/src/serve.ts, which names the gateway's mcp-auth.db at line 3\n",
  });
});

test('it fails on a daemon module that names mcp-auth.db inside a template', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/index.ts'),
    `export const SERVE = (dir: string) => \`\${dir}/mcp-auth.db\`;\n`,
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
    stderr:
      "named database: packages/daemon/src/index.ts reaches packages/daemon/src/index.ts, which names the gateway's mcp-auth.db at line 1\n",
  });
});

test('it fails on a daemon test helper that names mcp-auth.db in upper case', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/testing/index.ts'),
    "export const STUB = '/state/MCP-AUTH.DB';\n",
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
    stderr:
      "named database: packages/daemon/src/testing/index.ts reaches packages/daemon/src/testing/index.ts, which names the gateway's mcp-auth.db at line 1\n",
  });
});

test('it fails on a daemon test helper that reads the config path of mcp-auth.db', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/config/src/host/process-paths.ts'),
    "export const mcpAuthDBFile = '/state/mcp-auth.db';\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/testing/index.ts'),
    "import { mcpAuthDBFile } from '../../../config/src/host/process-paths';\n\nexport const STUB = mcpAuthDBFile;\n",
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
    stderr:
      "named database: packages/daemon/src/testing/index.ts reaches packages/daemon/src/testing/index.ts, which names the gateway's mcp-auth.db at line 1\n",
  });
});

test('it passes a daemon entry that reaches the config modules that define the mcp-auth.db path', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/config/src/host/resolve-paths.ts'),
    `export const resolvePaths = (dir: string) => ({ mcpAuthDBFile: \`\${dir}/mcp-auth.db\` });\n`,
  );

  await Bun.write(
    join(ctx.dir, 'packages/config/src/host/process-paths.ts'),
    "import { resolvePaths } from './resolve-paths';\n\nexport const { mcpAuthDBFile } = resolvePaths('/state');\n",
  );

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/index.ts'),
    "export * from '../../config/src/host/process-paths';\n",
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

test('it passes a daemon module that names mcp-auth.db only in a comment', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.dir, 'packages/app/src/gateway.ts'), 'console.log(1);\n');

  await Bun.write(
    join(ctx.dir, 'packages/daemon/src/index.ts'),
    '// never opens mcp-auth.db\nexport const DAEMON = 1;\n',
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
