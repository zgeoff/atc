import { expect, test } from 'bun:test';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
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
  const groups: number[] = [];

  const run = await runGit(['-c', 'alias.wait=!sleep 30', 'wait'], {
    timeoutMs: 200,
    onSpawn: (pid) => {
      groups.push(pid);
    },
  });

  expect(run).toStrictEqual({ exitCode: -1, stdout: '', stderr: '', timedOut: true });
  expect(groups).toHaveLength(1);

  // The timed git leads its own process group. A killed group is gone once
  // the kernel reaps it, a moment after the signal.
  await waitFor(() => {
    expect(() => process.kill(-(groups[0] ?? 0), 0)).toThrow('ESRCH');
  });
});

test('it reports the pid of the git it starts', async () => {
  const spawned: number[] = [];

  const run = await runGit(['-c', 'alias.parent=!echo $PPID', 'parent'], {
    onSpawn: (pid) => {
      spawned.push(pid);
    },
  });

  expect(spawned).toStrictEqual([Number(run.stdout.trim())]);
});
