import { expect, mock, test } from 'bun:test';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { updateEnv } from '../test-utils/update-env';
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
  const fixture = await createGitFixture({ prefix: 'atc-host-git-' });

  const remote = buildStubExecutionProvider({ remote: true });
  const runCommand = mock(remote.runCommand);
  const provider: ExecutionProvider = { ...remote, runCommand };

  const result = await runHostGit(provider, 's-1', fixture.work, ['symbolic-ref', 'HEAD']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: 'refs/heads/main\n', stderr: '' });

  expect(runCommand).toHaveBeenCalledExactlyOnceWith({
    argv: [
      'env',
      '-u',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      '-u',
      'GIT_COMMON_DIR',
      '-u',
      'GIT_CONFIG',
      '-u',
      'GIT_CONFIG_COUNT',
      '-u',
      'GIT_CONFIG_PARAMETERS',
      '-u',
      'GIT_DIR',
      '-u',
      'GIT_GRAFT_FILE',
      '-u',
      'GIT_IMPLICIT_WORK_TREE',
      '-u',
      'GIT_INDEX_FILE',
      '-u',
      'GIT_NO_REPLACE_OBJECTS',
      '-u',
      'GIT_OBJECT_DIRECTORY',
      '-u',
      'GIT_PREFIX',
      '-u',
      'GIT_REPLACE_REF_BASE',
      '-u',
      'GIT_SHALLOW_FILE',
      '-u',
      'GIT_WORK_TREE',
      'git',
      '-c',
      'safe.directory=*',
      '-c',
      'core.fsmonitor=false',
      '-C',
      fixture.work,
      'symbolic-ref',
      'HEAD',
    ],
    cwd: '/',
    host: 's-1',
  });
});
