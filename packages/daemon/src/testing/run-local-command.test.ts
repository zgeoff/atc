import { expect, test } from 'bun:test';
import { setupTempDir } from '@atc/test-utils';
import { runLocalCommand } from './run-local-command';

test('it runs the command in the spec directory and returns its output untrimmed', async () => {
  const temporaryDirectory = setupTempDir('atc-local-command-');

  const result = await runLocalCommand({ argv: ['pwd'], cwd: temporaryDirectory.path });

  expect(result).toStrictEqual({ exitCode: 0, stdout: `${temporaryDirectory.path}\n`, stderr: '' });
});

test('it returns the exit code and the error output of a command that fails', async () => {
  const temporaryDirectory = setupTempDir('atc-local-command-');

  const result = await runLocalCommand({
    argv: ['sh', '-c', 'echo broken >&2; exit 3'],
    cwd: temporaryDirectory.path,
  });

  expect(result).toStrictEqual({ exitCode: 3, stdout: '', stderr: 'broken\n' });
});
