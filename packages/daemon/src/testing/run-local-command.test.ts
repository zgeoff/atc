import { expect, test } from 'bun:test';
import { setupTempDir } from '@atc/test-utils';
import { runLocalCommand } from './run-local-command';

test('it runs the command in the spec directory and returns its output untrimmed', async () => {
  const tmp = setupTempDir('atc-local-command-');

  const result = await runLocalCommand({ argv: ['pwd'], cwd: tmp.path });

  expect(result).toStrictEqual({ exitCode: 0, stdout: `${tmp.path}\n`, stderr: '' });
});

test('it returns the exit code and the error output of a command that fails', async () => {
  const tmp = setupTempDir('atc-local-command-');

  const result = await runLocalCommand({
    argv: ['sh', '-c', 'echo broken >&2; exit 3'],
    cwd: tmp.path,
  });

  expect(result).toStrictEqual({ exitCode: 3, stdout: '', stderr: 'broken\n' });
});
