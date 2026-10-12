import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-run-command-');

  return { dir: tmp.dir };
}

test('it resolves with the exit code and output of a command', async () => {
  const result = await runCommand(['bash', '-c', 'printf out; printf err >&2; exit 3']);

  expect(result).toStrictEqual({ exitCode: 3, signalCode: null, stdout: 'out', stderr: 'err' });
});

test('it resolves with the signal that ended a command', async () => {
  const result = await runCommand(['bash', '-c', 'kill -TERM $$']);

  expect(result).toStrictEqual({ exitCode: null, signalCode: 'SIGTERM', stdout: '', stderr: '' });
});

test('it runs a command in its directory with its environment and input', async () => {
  const ctx = setupTest();

  const result = await runCommand(
    ['/bin/bash', '-c', 'printf "%s|%s|%s" "$PWD" "$ONLY" "$(cat)"'],
    {
      cwd: ctx.dir,
      env: { ONLY: 'set' },
      stdin: 'fed',
    },
  );

  expect(result.stdout).toBe(`${ctx.dir}|set|fed`);
});

test('it takes standard input as bytes', async () => {
  const result = await runCommand(['cat'], { stdin: Buffer.from('bytes') });

  expect(result.stdout).toBe('bytes');
});

test('it kills a command still running when the test finishes', () => {
  const run = runCommand(['sleep', '30']);

  onTestFinished(async () => {
    const result = await run;

    expect(result).toStrictEqual({
      exitCode: null,
      signalCode: 'SIGKILL',
      stdout: '',
      stderr: '',
    });
  });
});

test('it kills a child the command left holding its output when the test finishes', async () => {
  const ctx = setupTest();
  const pidPath = join(ctx.dir, 'child.pid');
  const run = runCommand(['bash', '-c', `sleep 30 & echo $! > '${pidPath}'; exit 0`]);

  await waitFor(() => {
    expect(readFileSync(pidPath, 'utf8')).toMatch(/^\d+\n$/);
  });

  const child = Number(readFileSync(pidPath, 'utf8'));

  onTestFinished(async () => {
    const result = await run;

    expect(result.stdout).toBe('');

    await waitFor(() => {
      expect(() => process.kill(child, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    });
  });
});
