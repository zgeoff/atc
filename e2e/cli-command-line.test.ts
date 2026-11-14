import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { resolveATCCommand, runATC, setupTempDir } from '@atc/test-utils';
import pkg from '../packages/app/package.json';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-cli-command-line-');

  return { directory: temporaryDirectory.path };
}

test.each([
  { args: ['hook-report', '--frobnicate'] },
  { args: ['hook-report', '--agent'] },
  { args: ['statusline', '--frobnicate'] },
  { args: ['answer', '--frobnicate'] },
])('it exits 0 on $args, a reporter command line it refuses', async (row) => {
  const ctx = setupTest();

  const ran = await runATC({ command: resolveATCCommand(), args: row.args, home: ctx.directory });

  expect({ stdout: ran.stdout, code: ran.exitCode }).toStrictEqual({ stdout: '', code: 0 });
});

test('it exits 1 on a command it does not know, with the reason on stderr', async () => {
  const ctx = setupTest();

  const ran = await runATC({
    command: resolveATCCommand(),
    args: ['frobnicate'],
    home: ctx.directory,
  });

  expect({ stderr: ran.stderr, code: ran.exitCode }).toStrictEqual({
    stderr: 'Command not found: frobnicate\n',
    code: 1,
  });
});

test('it prints the version and exits 0 on --version', async () => {
  const ctx = setupTest();

  const ran = await runATC({
    command: resolveATCCommand(),
    args: ['--version'],
    home: ctx.directory,
  });

  expect({ stdout: ran.stdout, code: ran.exitCode }).toStrictEqual({
    stdout: `${pkg.version}\n`,
    code: 0,
  });
});

test('it prints a secret and the sha256 digest of that secret on stdout for atc mcp service-secret', async () => {
  const ctx = setupTest();

  const ran = await runATC({
    command: resolveATCCommand(),
    args: ['mcp', 'service-secret'],
    home: ctx.directory,
  });

  const secret = /^secret: (?<value>svcs_\S+)$/mu.exec(ran.stdout)?.groups?.['value'] ?? '';

  expect({ stdout: ran.stdout, code: ran.exitCode }).toStrictEqual({
    stdout: `secret: ${secret}\ndigest: ${createHash('sha256').update(secret).digest('hex')}\n`,
    code: 0,
  });

  expect(secret).toStartWith('svcs_');
});
