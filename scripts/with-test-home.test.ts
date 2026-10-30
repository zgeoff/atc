import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killProcessGroup, runCommand, setupTempDir, waitFor } from '@atc/test-utils';

// A temp directory that holds the host config a test hands the script, and
// the directory outside any repository that the script's command runs in.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-with-test-home-');

  return { directory: temporaryDirectory.path };
}

// The left process is found through /proc, which only Linux has.
test.skipIf(process.platform !== 'linux')(
  'it removes the home and kills the process that a killed run left on the next run',
  async () => {
    const ctx = setupTest();
    const script = join(import.meta.dir, 'with-test-home.sh');
    const env = { ...process.env, TMPDIR: ctx.directory };

    // The sleep stands in for a daemon that the killed run never stopped. The
    // script stays running and holds the pipe, so the line is the first read.
    const killed = Bun.spawn(
      ['bash', script, 'sh', '-c', 'echo "$ATC_TEST_HOME $$"; exec sleep 30 > /dev/null'],
      { cwd: ctx.directory, env, stdout: 'pipe', detached: true },
    );

    onTestFinished(() => {
      killProcessGroup(killed.pid);
    });

    const line = await killed.stdout.getReader().read();

    const [root = '', left] = new TextDecoder().decode(line.value).trim().split(' ');

    const leftPID = Number(left);

    killed.kill('SIGKILL');

    await killed.exited;

    const next = await runCommand(['bash', script, 'true'], { cwd: ctx.directory, env });

    expect(next.exitCode).toBe(0);
    expect(existsSync(root)).toBeFalse();

    await waitFor(() => {
      expect(() => process.kill(leftPID, 0)).toThrow();
    });
  },
);

// The left process is found through /proc, which only Linux has.
test.skipIf(process.platform !== 'linux')(
  'it kills the process a command left running and removes the home when the command exits',
  async () => {
    const ctx = setupTest();

    // The sleep stands in for a daemon that a test never stopped. It shares
    // the process group that the wrapper leads.
    const run = await runCommand(
      [
        'bash',
        join(import.meta.dir, 'with-test-home.sh'),
        'sh',
        '-c',
        'sleep 30 > /dev/null & echo "$ATC_TEST_HOME $PPID $!"',
      ],
      { cwd: ctx.directory, env: { ...process.env, TMPDIR: ctx.directory } },
    );

    const [root = '', group, left] = run.stdout.trim().split(' ');
    const leftPID = Number(left);

    onTestFinished(() => {
      killProcessGroup(Number(group));
    });

    expect(run.exitCode).toBe(0);
    expect(existsSync(root)).toBeFalse();

    await waitFor(() => {
      expect(() => process.kill(leftPID, 0)).toThrow();
    });
  },
);

test('it keeps a host XDG git config away from a command it runs', async () => {
  const ctx = setupTest();
  const host = join(ctx.directory, 'host-xdg');

  mkdirSync(join(host, 'git'), { recursive: true });
  writeFileSync(join(host, 'git', 'config'), '[atc]\n\tcanary = host\n');

  const read = await runCommand(
    ['bash', join(import.meta.dir, 'with-test-home.sh'), 'git', 'config', '--get', 'atc.canary'],
    {
      cwd: ctx.directory,
      env: { ...process.env, XDG_CONFIG_HOME: host },
    },
  );

  expect({ exitCode: read.exitCode, stdout: read.stdout }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});
