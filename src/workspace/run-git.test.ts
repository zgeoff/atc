import { expect, test } from 'bun:test';
import { updateEnv } from '../../test/update-env';
import { runGit } from './run-git';

test('it drops git config that the host environment injects', async () => {
  updateEnv('GIT_CONFIG_KEY_0', 'atc.injected');
  updateEnv('GIT_CONFIG_VALUE_0', 'yes');

  const read = await runGit(['config', '--get', 'atc.injected'], {
    env: { GIT_CONFIG_COUNT: '1' },
  });

  expect(read.stdout).toBe('');
  expect(read.stderr).toInclude('missing config key GIT_CONFIG_KEY_0');
});

test('it reads no system attributes file in an isolated command', async () => {
  const located = await runGit(['var', 'GIT_ATTR_SYSTEM'], { isolated: true });

  expect(located).toStrictEqual({ exitCode: 1, stdout: '', stderr: '', timedOut: false });
});

test('it stops a command that runs past its time limit and reports it timed out', async () => {
  const started = Date.now();

  const run = await runGit(['-c', 'alias.wait=!sleep 30', 'wait'], { timeoutMs: 200 });

  expect(run).toStrictEqual({ exitCode: -1, stdout: '', stderr: '', timedOut: true });
  expect(Date.now() - started).toBeLessThan(5000);
});
