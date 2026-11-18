import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';
import { runCommand } from '@atc/core/test-utils/run-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { buildStubRecordingFilter } from './build-stub-recording-filter';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-recording-filter-');

  return { directory: temporaryDirectory.path };
}

test('it records each run and passes its input through unchanged', async () => {
  const ctx = setupTest();

  const filter = createStubBin(
    ctx.directory,
    'trap',
    buildStubRecordingFilter(join(ctx.directory, 'filter-ran')),
  );

  await runCommand([filter], { stdin: Buffer.from('first\n') });

  const second = await runCommand([filter], { stdin: Buffer.from('hello\n') });

  expect({ exitCode: second.exitCode, stdout: second.stdout }).toStrictEqual({
    exitCode: 0,
    stdout: 'hello\n',
  });

  expect(readFileSync(join(ctx.directory, 'filter-ran'), 'utf8')).toBe('ran\nran\n');
});
