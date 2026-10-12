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

test('it fails with git_output_open, by subcommand only, when a child a git left holds its output open past the bound', async () => {
  const ctx = setupTest();
  const groups: number[] = [];
  const armed: (() => void)[] = [];
  const reported: string[] = [];

  const run = runGit(
    ['-c', 'alias.hold=!sleep 30 & :', 'hold', 'https://user:secret@example.test'],
    {
      cwd: ctx.dir,
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

  // The bound arms once git exits; the sleep it left still holds the output.
  const bound = await waitFor(() => {
    invariant(armed[0]);

    return armed[0];
  });

  bound();

  expect(run).rejects.toMatchObject({
    code: 'git_output_open',
    message: 'git hold exited 0, but its output was still open 30000 ms later',
    data: { subcommand: 'hold', exitCode: 0 },
  });

  expect(reported).toStrictEqual([
    'atc: git hold exited 0, but its output was still open 30000 ms later; killing its process group',
  ]);
});

test('it kills the process group of a git whose output stays open past the bound', async () => {
  const ctx = setupTest();
  const groups: number[] = [];
  const armed: (() => void)[] = [];

  const run = runGit(['-c', 'alias.hold=!sleep 30 & :', 'hold'], {
    cwd: ctx.dir,
    onSpawn: (pid) => {
      groups.push(pid);
    },
    openOutputWatch: {
      schedule: (report) => {
        armed.push(report);

        return () => {};
      },
      report: () => {},
    },
  });

  const bound = await waitFor(() => {
    invariant(armed[0]);

    return armed[0];
  });

  bound();

  await run.catch(() => null);

  // Every git leads its own process group, so the kill reaches the sleep
  // it left. A killed group is gone once the kernel reaps it.
  await waitFor(() => {
    expect(() => process.kill(-(groups[0] ?? 0), 0)).toThrow('ESRCH');
  });
});

test('it disarms the bound when a command passes its time limit', async () => {
  const ctx = setupTest();
  const watched: { disarmed: boolean }[] = [];

  await runGit(['-c', 'alias.wait=!sleep 30', 'wait'], {
    cwd: ctx.dir,
    timeoutMs: 200,
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

  // The killed git exits a moment after the time limit, which arms the
  // bound only to disarm it.
  await waitFor(() => {
    expect(watched).toStrictEqual([{ disarmed: true }]);
  });
});

test('it disarms the bound once the output of the git closes', async () => {
  const ctx = setupTest();
  const watched: { afterMs: number; disarmed: boolean }[] = [];

  await runGit(['--version'], {
    cwd: ctx.dir,
    openOutputWatch: {
      schedule: (_report, afterMs) => {
        const entry = { afterMs, disarmed: false };

        watched.push(entry);

        return () => {
          entry.disarmed = true;
        };
      },
      report: () => {},
    },
  });

  expect(watched).toStrictEqual([{ afterMs: 30_000, disarmed: true }]);
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
