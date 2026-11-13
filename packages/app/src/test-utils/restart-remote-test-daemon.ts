import type { StartedTestDaemon, TestDaemonConfig } from '@atc/daemon/testing';
import { writeRemoteTestDaemonOptions } from './start-remote-test-daemon';

interface RestartOptions {
  readonly restoreFleet: boolean;
}

// Stops a remote test daemon and boots it again on its state directory, listener port, token and
// principals. With `restoreFleet` it restores the stored fleet by itself and the call returns once
// that restore has registered every session; without it the daemon boots with no sessions listed.
export async function restartRemoteTestDaemon(
  remote: StartedTestDaemon<TestDaemonConfig>,
  options: RestartOptions,
): Promise<void> {
  const port = remote.daemon.listenPort;

  if (port === null) {
    throw new Error('the remote daemon bound no TCP port');
  }

  const settled = Promise.withResolvers<void>();

  await remote.restart((paths) => ({
    ...writeRemoteTestDaemonOptions(paths, port),
    restoreFleetOnRestart: options.restoreFleet,
    onRestoreSettled: () => {
      settled.resolve();
    },
  }));

  if (options.restoreFleet) {
    await settled.promise;
  }
}
