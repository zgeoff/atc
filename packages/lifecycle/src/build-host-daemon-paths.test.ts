import { expect, test } from 'bun:test';
import { resolvePaths } from '@atc/config/host';
import { buildHostDaemonPaths } from './build-host-daemon-paths';
import { buildMockLifecycleHost } from './testing/build-mock-lifecycle-host';

test('it locates the daemon by the socket, record, and pid file of the host paths', () => {
  const paths = resolvePaths({ HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' });
  const host = buildMockLifecycleHost({ paths });

  expect(buildHostDaemonPaths(host)).toStrictEqual({
    socketPath: paths.daemonSocketPath,
    recordFile: paths.daemonRecordFile,
    pidFile: paths.daemonPidFile,
  });
});
