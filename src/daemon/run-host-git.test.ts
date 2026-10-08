import { expect, mock, test } from 'bun:test';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { updateEnv } from '../test-utils/update-env';
import { REPOSITORY_ENV_VARS } from '../workspace/repository-env-vars';
import type { ExecutionProvider } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';
import { runHostGit } from './run-host-git';

test('it runs git on the daemon machine for a local provider, past a GIT_DIR the daemon inherited', async () => {
  const fixture = await createGitFixture({ prefix: 'atc-host-git-' });

  updateEnv('GIT_DIR', '/nonexistent/.git');

  const result = await runHostGit(new LocalPTYProvider(), 's-1', fixture.work, [
    'rev-parse',
    '--show-toplevel',
  ]);

  expect(result).toStrictEqual({ exitCode: 0, stdout: `${fixture.work}\n`, stderr: '' });
});

test('it runs git through a remote provider without the repository variables', async () => {
  const runCommand = mock<ExecutionProvider['runCommand']>(() =>
    Promise.resolve({ exitCode: 0, stdout: 'main\n', stderr: '' }),
  );

  const provider: ExecutionProvider = {
    ...buildStubExecutionProvider(),
    remote: true,
    runCommand,
  };

  const result = await runHostGit(provider, 's-1', '/work', ['symbolic-ref', 'HEAD']);

  const [request] = runCommand.mock.calls[0] ?? [];

  expect(result.stdout).toBe('main\n');
  expect(request?.host).toBe('s-1');
  expect(request?.cwd).toBe('/');

  expect(request?.argv.slice(0, -9)).toStrictEqual([
    'env',
    ...[...REPOSITORY_ENV_VARS].flatMap((name) => ['-u', name]),
  ]);

  expect(REPOSITORY_ENV_VARS).toContain('GIT_DIR');

  expect(request?.argv.slice(-9)).toStrictEqual([
    'git',
    '-c',
    'safe.directory=*',
    '-c',
    'core.fsmonitor=false',
    '-C',
    '/work',
    'symbolic-ref',
    'HEAD',
  ]);
});
