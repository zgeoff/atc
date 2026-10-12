import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '@atc/test-utils/run-command';
import { runShellcheck } from '@atc/test-utils/run-shellcheck';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import invariant from 'tiny-invariant';
import { buildScratchLaunch } from './build-scratch-launch';

function setupTest() {
  const tmp = setupTempDir('atc-scratch-launch-');

  return { dir: tmp.dir };
}

test('it creates the scratch folder, readable by its owner alone, and runs the CLI with its own arguments', async () => {
  const ctx = setupTest();
  const scratch = join(ctx.dir, 'scratch');
  const out = join(ctx.dir, 'argv.txt');

  const launch = buildScratchLaunch(scratch, [
    'sh',
    '-c',
    String.raw`printf "%s\n" "$@" > "$0"`,
    out,
    'a b',
  ]);

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);
  expect(statSync(scratch).mode & 0o777).toBe(0o700);
  expect(readFileSync(out, 'utf8')).toBe('a b\n');
});

test('it takes an existing scratch folder back to its owner alone', async () => {
  const ctx = setupTest();
  const scratch = join(ctx.dir, 'scratch');
  const launch = buildScratchLaunch(scratch, ['true']);

  mkdirSync(scratch);
  chmodSync(scratch, 0o755);

  const run = await runCommand([launch.bin, ...launch.args]);

  expect(run.exitCode).toBe(0);
  expect(statSync(scratch).mode & 0o777).toBe(0o700);
});

test('it gives the CLI the scratch folder as its temporary folder', () => {
  expect(buildScratchLaunch('/tmp/atc/sessions/s1/scratch', ['claude']).env).toStrictEqual({
    TMPDIR: '/tmp/atc/sessions/s1/scratch',
  });
});

test('it builds a launch script that passes shellcheck', async () => {
  const launch = buildScratchLaunch('/tmp/atc/sessions/s1/scratch', ['claude']);
  const [flag, script] = launch.args;

  invariant(script !== undefined);

  const result = await runShellcheck(script);

  expect(flag).toBe('-c');
  expect(result).toStrictEqual({ exitCode: 0, findings: [] });
});
