import { expect, test } from 'bun:test';
import { createGitFixture, runLocalCommand, updateEnv } from '@atc/test-utils';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { runHostGit } from './run-host-git';

test('it runs git on the daemon machine for a local provider, past a GIT_DIR the daemon inherited', async () => {
  const fixture = await createGitFixture({ prefix: 'atc-host-git-' });

  const provider = buildStubMemoryProvider({ kind: 'local-pty', runCommand: runLocalCommand });

  updateEnv('GIT_DIR', '/nonexistent/.git');

  const result = await runHostGit(provider, 's-1', fixture.work, ['rev-parse', '--show-toplevel']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: `${fixture.work}\n`, stderr: '' });
});

test('it runs git through a remote provider without the repository variables', async () => {
  const fixture = await createGitFixture({ prefix: 'atc-host-git-' });

  const provider = buildStubMemoryProvider({ remote: true, runCommand: runLocalCommand });

  const result = await runHostGit(provider, 's-1', fixture.work, ['symbolic-ref', 'HEAD']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: 'refs/heads/main\n', stderr: '' });

  expect(provider.commands).toStrictEqual([
    {
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
    },
  ]);
});
