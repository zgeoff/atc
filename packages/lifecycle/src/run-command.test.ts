import { expect, test } from 'bun:test';
import { runCommand } from './run-command';

test('it returns the exit code and the trimmed output of a command', async () => {
  const result = await runCommand(['sh', '-c', 'echo " out "; echo " err " >&2; exit 3']);

  expect(result).toStrictEqual({ code: 3, stdout: 'out', stderr: 'err' });
});

test('it reads a command that cannot start as exit code 127', async () => {
  const result = await runCommand(['atc-no-such-command']);

  expect(result).toStrictEqual({ code: 127, stdout: '', stderr: expect.toBeString() });
});
