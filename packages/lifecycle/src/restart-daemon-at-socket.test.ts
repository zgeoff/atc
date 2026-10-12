import { expect, mock, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config/resolve-paths';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { restartDaemonAtSocket } from './restart-daemon-at-socket';
import { buildMockLifecycleHost } from './testing/build-mock-lifecycle-host';

/**
 * A home whose runtime directory is the home itself, an empty directory
 * that stands in for `/proc`, and a stand-in daemon that sleeps until it is
 * stopped.
 */
function setupTest() {
  const dir = setupTempDir('restart-daemon-at-socket-').dir;
  const paths = resolvePaths({ HOME: dir, XDG_RUNTIME_DIR: dir });
  const procRoot = join(dir, 'proc');

  // The record the daemon keeps lives in the state directory.
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(procRoot);

  const daemon = Bun.spawn(['sleep', '60']);

  registerTestCleanup(() => {
    daemon.kill('SIGKILL');
  });

  return { paths, procRoot, daemon };
}

test('it stops the daemon whose record lists the socket', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.paths.daemonRecordFile,
    JSON.stringify({
      pid: ctx.daemon.pid,
      socketPath: ctx.paths.daemonSocketPath,
      reporterSocketPath: ctx.paths.socketPath,
      eventsSocketPath: null,
    }),
  );

  const host = buildMockLifecycleHost({ paths: ctx.paths, procRoot: ctx.procRoot });

  const restarted = await restartDaemonAtSocket(host, ctx.paths.daemonSocketPath);

  await ctx.daemon.exited;

  expect(restarted).toBeTrue();
  expect(ctx.daemon.signalCode).toBe('SIGTERM');
});

test('it restarts the unit whose main process is the daemon behind the socket', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.paths.daemonRecordFile,
    JSON.stringify({
      pid: ctx.daemon.pid,
      socketPath: ctx.paths.daemonSocketPath,
      reporterSocketPath: ctx.paths.socketPath,
      eventsSocketPath: null,
    }),
  );

  // The daemon's cgroup puts it in a user service, as one a user manager
  // runs reads.
  const uid = process.getuid?.() ?? 0;

  mkdirSync(join(ctx.procRoot, String(ctx.daemon.pid)));

  writeFileSync(
    join(ctx.procRoot, String(ctx.daemon.pid), 'cgroup'),
    `0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/atc-daemon.service\n`,
  );

  const runSystemctl = mock((args: readonly string[]) =>
    Promise.resolve({
      code: 0,
      stdout: args[0] === 'show' ? String(ctx.daemon.pid) : '',
      stderr: '',
      aborted: false,
    }),
  );

  const host = buildMockLifecycleHost({
    paths: ctx.paths,
    procRoot: ctx.procRoot,
    runSystemctl,
  });

  const restarted = await restartDaemonAtSocket(host, ctx.paths.daemonSocketPath);

  expect(restarted).toBeTrue();

  expect(runSystemctl.mock.calls).toStrictEqual([
    [['show', '-p', 'MainPID', '--value', 'atc-daemon.service']],
    [['restart', 'atc-daemon.service']],
  ]);
});

test('it leaves every process alone when no pid for the socket is found', async () => {
  const ctx = setupTest();

  const runSystemctl = mock(() =>
    Promise.resolve({ code: 0, stdout: '', stderr: '', aborted: false }),
  );

  const host = buildMockLifecycleHost({
    paths: ctx.paths,
    procRoot: ctx.procRoot,
    runSystemctl,
  });

  const restarted = await restartDaemonAtSocket(host, ctx.paths.daemonSocketPath);

  expect(restarted).toBeFalse();
  expect(() => process.kill(ctx.daemon.pid, 0)).not.toThrow();
  expect(runSystemctl).not.toHaveBeenCalled();
});
