import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for the cloned tap and the release's dist/.
function setupTest() {
  const temporaryDirectory = setupTempDir('should-write-formula-');

  return { directory: temporaryDirectory.path };
}

test.each([
  ['7.10.0', '7.3.1', 1, 'the formula holds 7.10.0, newer than 7.3.1; left as it is\n'],
  ['7.3.1', '7.3.1', 0, ''],
  ['7.3.0', '7.3.1', 0, ''],
])(
  'it answers a tap formula at %s for a release of %s with exit code %d',
  async (tapVersion, version, exitCode, stdout) => {
    const ctx = setupTest();
    const sums = join(ctx.directory, 'SHA256SUMS');
    const formula = join(ctx.directory, 'atc.rb');

    await Bun.write(
      sums,
      'aa  atc-darwin-arm64\nbb  atc-darwin-x64\ncc  atc-linux-arm64\ndd  atc-linux-x64\n',
    );

    const built = await runCommand([
      'bash',
      join(import.meta.dir, 'build-formula.sh'),
      tapVersion,
      sums,
    ]);

    await Bun.write(formula, built.stdout);

    const answered = await runCommand([
      'bash',
      join(import.meta.dir, 'should-write-formula.sh'),
      formula,
      version,
    ]);

    expect({
      exitCode: answered.exitCode,
      stdout: answered.stdout,
      stderr: answered.stderr,
    }).toStrictEqual({ exitCode, stdout, stderr: '' });
  },
);

test('it lets a release write a tap that holds no formula', async () => {
  const ctx = setupTest();

  const answered = await runCommand([
    'bash',
    join(import.meta.dir, 'should-write-formula.sh'),
    join(ctx.directory, 'atc.rb'),
    '7.3.1',
  ]);

  expect({
    exitCode: answered.exitCode,
    stdout: answered.stdout,
    stderr: answered.stderr,
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});
