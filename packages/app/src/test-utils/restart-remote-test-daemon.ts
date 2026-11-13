import type { StartedTestDaemon, TestDaemonConfig } from '@atc/daemon/testing';
import { writeRemoteTestDaemonOptions } from './start-remote-test-daemon';

interface RestartOptions {
  readonly restoreFleet: boolean;
}

// Stops a remote test daemon and boots it again on its state directory, listener port, token and
// principals. With `restoreFleet` the call settles with the daemon's own fleet restore; without it
// the daemon boots with no sessions listed.
export async function restartRemoteTestDaemon(
  remote: StartedTestDaemon<TestDaemonConfig>,
  options: RestartOptions,
): Promise<void> {
  const port = remote.daemon.listenPort;

  if (port === null) {
    throw new Error('the remote daemon bound no TCP port');
  }

  if (!options.restoreFleet) {
    await remote.restart((paths) => ({
      ...writeRemoteTestDaemonOptions(paths, port),
      restoreFleetOnRestart: false,
    }));

    return;
  }

  const settled = Promise.withResolvers<void>();

  await Promise.all([
    remote.restart((paths) => ({
      ...writeRemoteTestDaemonOptions(paths, port),
      restoreFleetOnRestart: true,
      onRestoreSettled: (restore) => {
        if (restore.outcome === 'failed') {
          settled.reject(new Error('the remote daemon failed to restore its fleet'));

          return;
        }

        settled.resolve();
      },
      onRestoreSkipped: (reason) => {
        settled.reject(new Error(`the remote daemon skipped its fleet restore: ${reason}`));
      },
    })),
    settled.promise,
  ]);
}
