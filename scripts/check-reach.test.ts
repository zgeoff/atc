import { expect, test } from 'bun:test';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../packages/app/src/test-utils/run-command';
import { setupTempDir } from '../packages/app/src/test-utils/setup-temp-dir';

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
