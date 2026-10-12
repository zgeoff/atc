import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingFilter } from './build-stub-recording-filter';
import { createStubBin } from './create-stub-bin';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const tmp = setupTempDir('atc-stub-recording-filter-');

  return { dir: tmp.dir };
}

test('it records each run and passes its input through unchanged', async () => {
  const ctx = setupTest();

  const filter = createStubBin(
    ctx.dir,
    'trap',
    buildStubRecordingFilter(join(ctx.dir, 'filter-ran')),
  );

  await runCommand([filter], { stdin: Buffer.from('first\n') });

  const second = await runCommand([filter], { stdin: Buffer.from('hello\n') });

  expect({ exitCode: second.exitCode, stdout: second.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: 'hello\n',
  });

  expect(readFileSync(join(ctx.dir, 'filter-ran'), 'utf8')).toBe('ran\nran\n');
});
