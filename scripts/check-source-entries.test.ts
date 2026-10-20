import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root.
function setupTest() {
  const temporaryDirectory = setupTempDir('check-source-entries-');

  return { directory: temporaryDirectory.path };
}

test('it passes helpers that read the source entry from the wrapper variable', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'scripts/with-test-home.sh'),
    'repo=$(pwd)\nexport ATC_CLI_ENTRY="$repo/packages/app/src/cli.ts"\n',
  );

  await Bun.write(
    join(ctx.directory, 'packages/test-utils/src/run-probe.ts'),
    "export const PROBE = [process.execPath, process.env['ATC_CLI_ENTRY']];\n",
  );

  // a helper's own unit test holds an entry path as fixture data
  await Bun.write(
    join(ctx.directory, 'packages/test-utils/src/run-probe.test.ts'),
    "export const FIXTURE = '/checkout/packages/app/src/cli.ts';\n",
  );

  // a module outside the helper folders is not a test helper
  await Bun.write(
    join(ctx.directory, 'packages/lantern/src/is-entry.ts'),
    "export const ENTRY = '/src/cli.ts';\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-source-entries.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-source-entries: 0 hard-coded source entries\n',
    stderr: '',
  });
});

test('it fails on a helper that hard-codes a source entry path or joins its segments', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'scripts/with-test-home.sh'),
    [
      'repo=$(pwd)',
      'export ATC_CLI_ENTRY="$repo/packages/app/src/cli.ts"',
      'export ATC_GATEWAY_ENTRY="$repo/packages/app/src/gateway.ts"',
      '',
    ].join('\n'),
  );

  await Bun.write(
    join(ctx.directory, 'packages/test-utils/src/run-probe.ts'),
    "// starts the probe\nexport const PROBE = ['bun', 'packages/app/src/cli.ts'];\n",
  );

  await Bun.write(
    join(ctx.directory, 'packages/app/src/test-utils/start-probe.ts'),
    "export const PROBE = join(root, 'src', 'gateway.ts');\n",
  );

  await Bun.write(
    join(ctx.directory, 'e2e/probe.test.ts'),
    "const entry = join(import.meta.dir, '..', 'packages', 'app', 'src', 'cli.ts');\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-source-entries.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-source-entries: 3 hard-coded source entries\n',
    stderr: [
      'hard-coded source entry: e2e/probe.test.ts:1 holds packages/app/src/cli.ts; read it from ATC_CLI_ENTRY',
      'hard-coded source entry: packages/app/src/test-utils/start-probe.ts:1 holds packages/app/src/gateway.ts; read it from ATC_GATEWAY_ENTRY',
      'hard-coded source entry: packages/test-utils/src/run-probe.ts:2 holds packages/app/src/cli.ts; read it from ATC_CLI_ENTRY',
      '',
    ].join('\n'),
  });
});

test('it checks against the entry path the wrapper exports after a package move', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, 'scripts/with-test-home.sh'),
    'repo=$(pwd)\nexport ATC_CLI_ENTRY="$repo/packages/console/src/main.ts"\n',
  );

  await Bun.write(
    join(ctx.directory, 'packages/daemon/src/testing/start-probe.ts'),
    "export const OLD = 'packages/app/src/cli.ts';\nexport const NEW = 'packages/console/src/main.ts';\n",
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-source-entries.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-source-entries: 1 hard-coded source entries\n',
    stderr:
      'hard-coded source entry: packages/daemon/src/testing/start-probe.ts:2 holds packages/console/src/main.ts; read it from ATC_CLI_ENTRY\n',
  });
});

test('it fails when the wrapper exports no source entry', async () => {
  const ctx = setupTest();

  await Bun.write(join(ctx.directory, 'scripts/with-test-home.sh'), 'repo=$(pwd)\n');

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-source-entries.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'scripts/with-test-home.sh exports no ATC_*_ENTRY variable\n',
  });
});
