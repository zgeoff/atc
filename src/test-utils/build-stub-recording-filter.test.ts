import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingFilter } from './build-stub-recording-filter';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-recording-filter-');
}

test('it records each run and passes its input through unchanged', () => {
  using ctx = setupTest();

  const filter = createStubBin(
    ctx.dir,
    'trap',
    buildStubRecordingFilter(join(ctx.dir, 'filter-ran')),
  );

  Bun.spawnSync([filter], { stdin: Buffer.from('first\n') });

  const second = Bun.spawnSync([filter], { stdin: Buffer.from('hello\n') });

  expect({
    exitCode: second.exitCode,
    stdout: second.stdout.toString(),
    record: readFileSync(join(ctx.dir, 'filter-ran'), 'utf8'),
  }).toStrictEqual({ exitCode: 0, stdout: 'hello\n', record: 'ran\nran\n' });
});
