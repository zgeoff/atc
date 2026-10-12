import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '@atc/test-utils/run-command';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';

// A temp directory standing in for a repo root.
function setupTest() {
  const tmp = setupTempDir('run-wave-move-');

  return { dir: tmp.dir };
}

test('it moves the wave files and points their importers at the package entry', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\tpath_wave2\nsrc/test-utils/wait-for.ts\ttest-utils\tpackages/app/src/test-utils/wait-for.ts\tpackages/test-utils/src/wait-for.ts\nsrc/daemon/boot.ts\tdaemon\tpackages/app/src/daemon/boot.ts\tpackages/app/src/daemon/boot.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-testmap.tsv'),
    'test\tpath_wave1\tpath_wave2\nsrc/daemon/boot.test.ts\tpackages/app/src/daemon/boot.test.ts\tpackages/app/src/daemon/boot.test.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { './*': './src/*.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/test-utils/wait-for.ts'),
    "import { BOOT } from '../daemon/boot';\n\nexport const waitFor = BOOT;\n",
  );

  await Bun.write(join(ctx.dir, 'packages/app/src/daemon/boot.ts'), 'export const BOOT = 1;\n');

  await Bun.write(
    join(ctx.dir, 'packages/app/src/daemon/boot.test.ts'),
    "import { waitFor } from '../test-utils/wait-for';\n\nexport const A = waitFor;\n",
  );

  const moved = await runCommand([
    process.execPath,
    join(import.meta.dir, 'run-wave-move.ts'),
    '2',
    ctx.dir,
  ]);

  expect({ exitCode: moved.exitCode, stdout: moved.stdout, stderr: moved.stderr }).toStrictEqual({
    exitCode: 0,
    stdout: 'run-wave-move: wave 2, 1 files moved, 2 files rewritten\n',
    stderr: '',
  });

  expect(existsSync(join(ctx.dir, 'packages/app/src/test-utils/wait-for.ts'))).toBe(false);

  expect(readFileSync(join(ctx.dir, 'packages/test-utils/src/wait-for.ts'), 'utf8')).toBe(
    "import { BOOT } from '../../app/src/daemon/boot';\n\nexport const waitFor = BOOT;\n",
  );

  expect(readFileSync(join(ctx.dir, 'packages/app/src/daemon/boot.test.ts'), 'utf8')).toBe(
    "import { waitFor } from '@atc/test-utils/wait-for';\n\nexport const A = waitFor;\n",
  );
});

test('it leaves a string that matches a rewritten specifier unchanged', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\tpath_wave2\nsrc/test-utils/wait-for.ts\ttest-utils\tpackages/app/src/test-utils/wait-for.ts\tpackages/test-utils/src/wait-for.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-testmap.tsv'),
    'test\tpath_wave1\tpath_wave2\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { './*': './src/*.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/test-utils/wait-for.ts'),
    'export const waitFor = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/a.test.ts'),
    "import { waitFor } from './test-utils/wait-for';\n\nexport const LABEL = './test-utils/wait-for';\nexport const A = waitFor;\n",
  );

  await runCommand([process.execPath, join(import.meta.dir, 'run-wave-move.ts'), '2', ctx.dir]);

  expect(readFileSync(join(ctx.dir, 'packages/app/src/a.test.ts'), 'utf8')).toBe(
    "import { waitFor } from '@atc/test-utils/wait-for';\n\nexport const LABEL = './test-utils/wait-for';\nexport const A = waitFor;\n",
  );
});

test('it moves the sources that wave 1 takes from src', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\nsrc/cli.ts\tapp\tpackages/app/src/cli.ts\n',
  );

  await Bun.write(join(ctx.dir, 'scripts/package-map/package-testmap.tsv'), 'test\tpath_wave1\n');
  await Bun.write(join(ctx.dir, 'src/cli.ts'), 'export const CLI = 1;\n');

  const moved = await runCommand([
    process.execPath,
    join(import.meta.dir, 'run-wave-move.ts'),
    '1',
    ctx.dir,
  ]);

  expect({ exitCode: moved.exitCode, stdout: moved.stdout, stderr: moved.stderr }).toStrictEqual({
    exitCode: 0,
    stdout: 'run-wave-move: wave 1, 1 files moved, 0 files rewritten\n',
    stderr: '',
  });

  expect(readFileSync(join(ctx.dir, 'packages/app/src/cli.ts'), 'utf8')).toBe(
    'export const CLI = 1;\n',
  );
});

test('it changes nothing on a second run of the same wave', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-stagemap.tsv'),
    'source\tfinal\tpath_wave1\tpath_wave2\nsrc/test-utils/wait-for.ts\ttest-utils\tpackages/app/src/test-utils/wait-for.ts\tpackages/test-utils/src/wait-for.ts\n',
  );

  await Bun.write(
    join(ctx.dir, 'scripts/package-map/package-testmap.tsv'),
    'test\tpath_wave1\tpath_wave2\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/test-utils/package.json'),
    JSON.stringify({ name: '@atc/test-utils', exports: { './*': './src/*.ts' } }),
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/test-utils/wait-for.ts'),
    'export const waitFor = 1;\n',
  );

  await Bun.write(
    join(ctx.dir, 'packages/app/src/a.test.ts'),
    "import { waitFor } from './test-utils/wait-for';\n\nexport const A = waitFor;\n",
  );

  await runCommand([process.execPath, join(import.meta.dir, 'run-wave-move.ts'), '2', ctx.dir]);

  const again = await runCommand([
    process.execPath,
    join(import.meta.dir, 'run-wave-move.ts'),
    '2',
    ctx.dir,
  ]);

  expect({ exitCode: again.exitCode, stdout: again.stdout, stderr: again.stderr }).toStrictEqual({
    exitCode: 0,
    stdout: 'run-wave-move: wave 2, 0 files moved, 0 files rewritten\n',
    stderr: '',
  });

  expect(readFileSync(join(ctx.dir, 'packages/app/src/a.test.ts'), 'utf8')).toBe(
    "import { waitFor } from '@atc/test-utils/wait-for';\n\nexport const A = waitFor;\n",
  );
});
