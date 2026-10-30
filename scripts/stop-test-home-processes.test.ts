import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { $ } from 'bun';
import { stopTestHomeProcesses } from './stop-test-home-processes';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stop-test-home-');

  return { directory: temporaryDirectory.path };
}

// The processes are read from /proc, which only Linux has.
test.skipIf(process.platform !== 'linux')(
  'it kills a process that holds the run directory in ATC_TEST_HOME',
  async () => {
    const ctx = setupTest();
    const root = join(ctx.directory, 'atc-test-home-left');
    const left = Bun.spawn(['sleep', '30'], { env: { ...process.env, ATC_TEST_HOME: root } });

    onTestFinished(() => {
      left.kill('SIGKILL');
    });

    const stopped = await stopTestHomeProcesses({ root, procRoot: '/proc', ownPID: process.pid });

    await left.exited;

    expect(stopped).toStrictEqual([left.pid]);
    expect(left.signalCode).toBe('SIGKILL');
  },
);

test.skipIf(process.platform !== 'linux')(
  'it never kills a process of another run directory',
  async () => {
    const ctx = setupTest();

    const other = Bun.spawn(['sleep', '30'], {
      env: { ...process.env, ATC_TEST_HOME: join(ctx.directory, 'atc-test-home-other') },
    });

    onTestFinished(() => {
      other.kill('SIGKILL');
    });

    const stopped = await stopTestHomeProcesses({
      root: join(ctx.directory, 'atc-test-home-mine'),
      procRoot: '/proc',
      ownPID: process.pid,
    });

    expect(stopped).toStrictEqual([]);
    expect(other.exitCode).toBeNull();
  },
);

test.skipIf(process.platform !== 'linux')(
  'it refuses a second argument and kills nothing',
  async () => {
    const ctx = setupTest();
    const root = join(ctx.directory, 'atc-test-home-left');
    const left = Bun.spawn(['sleep', '30'], { env: { ...process.env, ATC_TEST_HOME: root } });

    onTestFinished(() => {
      left.kill('SIGKILL');
    });

    const run = await $`bun ${join(import.meta.dir, 'stop-test-home-processes.ts')} ${root} extra`
      .nothrow()
      .quiet();

    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toStrictEqual({
      exitCode: 2,
      stderr: 'stop-test-home-processes: pass the run directory as the only argument\n',
    });

    expect(left.exitCode).toBeNull();
  },
);

test('it stops nothing on a host with no procfs', async () => {
  const ctx = setupTest();

  const stopped = await stopTestHomeProcesses({
    root: join(ctx.directory, 'atc-test-home-mine'),
    procRoot: join(ctx.directory, 'proc'),
    ownPID: process.pid,
  });

  expect(stopped).toStrictEqual([]);
});
