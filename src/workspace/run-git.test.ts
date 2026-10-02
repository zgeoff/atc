import { expect, onTestFinished, test } from 'bun:test';
import { runGit } from './run-git';

test('it drops git config that the host environment injects', async () => {
  process.env['GIT_CONFIG_KEY_0'] = 'atc.injected';
  process.env['GIT_CONFIG_VALUE_0'] = 'yes';

  onTestFinished(() => {
    delete process.env['GIT_CONFIG_KEY_0'];
    delete process.env['GIT_CONFIG_VALUE_0'];
  });

  const read = await runGit(['config', '--get', 'atc.injected'], {
    env: { GIT_CONFIG_COUNT: '1' },
  });

  expect(read.stdout).toBe('');
  expect(read.stderr).toInclude('missing config key GIT_CONFIG_KEY_0');
});
