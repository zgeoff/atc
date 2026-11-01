import { expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { findPTYLibraryCopy, runCopyPTYLibrary } from './copy-pty-library';
import type { RunProgram } from './run-program';

function setupTest() {
  const temporaryDirectory = setupTempDir('copy-pty-library-');
  const directory = temporaryDirectory.path;
  const bin = join(directory, 'atc');
  const commands: string[] = [];
  const output = { stdout: '', stderr: '' };

  writeFileSync(bin, '');

  const run = (env: Readonly<Record<string, string | undefined>>, runProgram: RunProgram) =>
    runCopyPTYLibrary({
      cwd: directory,
      env,
      tempDirectory: directory,
      uid: 501,
      runProgram: (argv, options) => {
        commands.push(argv.join(' '));

        return runProgram(argv, options);
      },
      writeStdout: (text) => {
        output.stdout += text;
      },
      writeStderr: (text) => {
        output.stderr += text;
      },
    });

  return { directory, bin, commands, output, run };
}

test.each([
  { label: 'a Linux copy', names: ['.bun-501-9f2c4e1a.so'], expected: '.bun-501-9f2c4e1a.so' },
  {
    label: 'a macOS copy',
    names: ['atc-test-home-Qx81', '.bun-501-9f2c4e1a.dylib'],
    expected: '.bun-501-9f2c4e1a.dylib',
  },
])('it finds $label of the PTY library', (row) => {
  expect(findPTYLibraryCopy(row.names, 501)).toBe(row.expected);
});

test.each([
  { label: 'an empty temp directory', names: [] },
  { label: "another user's copy", names: ['.bun-502-9f2c4e1a.so'] },
  { label: 'a scratch file that never reached its final name', names: ['.7d1e0b2c-0.so'] },
  { label: 'a copy of another kind of file', names: ['.bun-501-9f2c4e1a.txt'] },
])('it finds no copy of the PTY library in $label', (row) => {
  expect(findPTYLibraryCopy(row.names, 501)).toBeUndefined();
});

test('it leaves a copy of the PTY library in an empty temp directory after the serial daemon suite', () => {
  const ctx = setupTest();

  // The stand-in suite writes the copy that a real daemon's first PTY writes.
  const code = ctx.run({ ATC_BIN: ctx.bin }, (argv) => {
    if (argv.includes('test:e2e')) {
      writeFileSync(join(ctx.directory, '.bun-501-9f2c4e1a.dylib'), 'library');
    }

    return { exitCode: 0, stdout: '', stderr: '' };
  });

  expect(code).toBe(0);

  expect(ctx.commands).toStrictEqual([
    `${ctx.bin} --version`,
    'bun run test:e2e e2e/daemon-env.test.ts',
  ]);

  expect(readdirSync(ctx.directory)).toContain('.bun-501-9f2c4e1a.dylib');
  expect(ctx.output.stdout).toInclude(join(ctx.directory, '.bun-501-9f2c4e1a.dylib'));
});

test('it exits 1 when ATC_BIN names no file', () => {
  const ctx = setupTest();

  const code = ctx.run({ ATC_BIN: join(ctx.directory, 'missing') }, () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
  }));

  expect(code).toBe(1);
  expect(ctx.commands).toStrictEqual([]);
  expect(ctx.output.stderr).toInclude('copy-pty-library:');
});

test('it exits 1 when the binary fails to run', () => {
  const ctx = setupTest();

  const code = ctx.run({ ATC_BIN: ctx.bin }, () => ({
    exitCode: 126,
    stdout: '',
    stderr: 'exec format error\n',
  }));

  expect(code).toBe(1);
  expect(ctx.commands).toStrictEqual([`${ctx.bin} --version`]);
  expect(ctx.output.stderr).toInclude(`${ctx.bin} --version exited with 126`);
});

test('it exits 1 when the serial daemon suite leaves no copy', () => {
  const ctx = setupTest();
  const code = ctx.run({ ATC_BIN: ctx.bin }, () => ({ exitCode: 0, stdout: '', stderr: '' }));

  expect(code).toBe(1);
  expect(ctx.output.stderr).toInclude('no copy of the PTY library');
});
