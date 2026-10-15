import { expect, test } from 'bun:test';
import { resolvePaths } from '@atc/config/host';
import { buildHostDaemonPaths } from './build-host-daemon-paths';
import { buildMockLifecycleHost } from './testing/build-mock-lifecycle-host';

test('it locates the daemon by the socket, record, and pid file of the host paths', () => {
  const host = buildMockLifecycleHost({
    paths: resolvePaths({ HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' }),
  });

  expect(buildHostDaemonPaths(host)).toStrictEqual({
    socketPath: '/run/user/1000/atc-daemon.sock',
    recordFile: '/home/u/.local/state/atc/daemon.json',
    pidFile: '/run/user/1000/atc-daemon.pid',
  });
});
