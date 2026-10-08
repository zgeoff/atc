import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { runGit } from './run-git';

// A directory outside any repository for git to run in.
function setupTest() {
  const tmp = setupTempDir('atc-run-git-');

  return { dir: tmp.dir };
}

test('it drops git config that the host environment injects', async () => {
  const ctx = setupTest();

  updateEnv('GIT_CONFIG_KEY_0', 'atc.injected');
  updateEnv('GIT_CONFIG_VALUE_0', 'yes');

  const read = await runGit(['config', '--get', 'atc.injected'], {
    cwd: ctx.dir,
    env: { GIT_CONFIG_COUNT: '1' },
  });

  expect(read.stdout).toBe('');
  expect(read.stderr).toInclude('missing config key GIT_CONFIG_KEY_0');
});

test('it reads no system attributes file in an isolated command', async () => {
  const ctx = setupTest();

  const located = await runGit(['var', 'GIT_ATTR_SYSTEM'], { cwd: ctx.dir, isolated: true });

  expect(located).toStrictEqual({ exitCode: 1, stdout: '', stderr: '', timedOut: false });
});

test('it stops a command that runs past its time limit and reports it timed out', async () => {
  const ctx = setupTest();
  const groups: number[] = [];

  const run = await runGit(['-c', 'alias.wait=!sleep 30', 'wait'], {
    cwd: ctx.dir,
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

test('it reports a git that exits while a child it left holds its output open, by subcommand only', async () => {
  const ctx = setupTest();
  const groups: number[] = [];
  const armed: (() => void)[] = [];
  const reported: string[] = [];

  const run = runGit(
    ['-c', 'alias.hold=!sleep 30 & :', 'hold', 'https://user:secret@example.test'],
    {
      cwd: ctx.dir,
      timeoutMs: 20_000,
      onSpawn: (pid) => {
        groups.push(pid);
      },
      openOutputWatch: {
        schedule: (report) => {
          armed.push(report);

          return () => {};
        },
        report: (line) => {
          reported.push(line);
        },
      },
    },
  );

  // The watch arms once git exits; the sleep it left still holds the output.
  const report = await waitFor(() => {
    invariant(armed[0]);

    return armed[0];
  });

  report();

  const [group] = groups;

  invariant(group !== undefined && group > 0);

  process.kill(-group, 'SIGKILL');

  await run;

  expect(reported).toStrictEqual([
    'atc: git hold exited 0, but its output was still open 5000 ms later',
  ]);
});

test('it disarms the open-output report once the output of the git closes', async () => {
  const ctx = setupTest();
  const watched: { disarmed: boolean }[] = [];

  await runGit(['--version'], {
    cwd: ctx.dir,
    openOutputWatch: {
      schedule: () => {
        const entry = { disarmed: false };

        watched.push(entry);

        return () => {
          entry.disarmed = true;
        };
      },
      report: () => {},
    },
  });

  expect(watched).toStrictEqual([{ disarmed: true }]);
});

test('it reports the pid of the git it starts', async () => {
  const ctx = setupTest();
  const spawned: number[] = [];

  const run = await runGit(['-c', 'alias.parent=!echo $PPID', 'parent'], {
    cwd: ctx.dir,
    onSpawn: (pid) => {
      spawned.push(pid);
    },
  });

  expect(spawned).toStrictEqual([Number(run.stdout.trim())]);
});
