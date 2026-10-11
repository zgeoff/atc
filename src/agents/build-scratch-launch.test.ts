import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../test-utils/run-command';
import { setupTempDir } from '../test-utils/setup-temp-dir';
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

test('it gives the CLI the scratch folder as its temporary folder', () => {
  expect(buildScratchLaunch('/tmp/atc/sessions/s1/scratch', ['claude']).env).toStrictEqual({
    TMPDIR: '/tmp/atc/sessions/s1/scratch',
  });
});
