import { expect, test } from 'bun:test';
import { resolvePaths } from './resolve-paths';

test('it puts the sockets and the pid file in the runtime folder the environment sets', () => {
  expect(resolvePaths({ HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' })).toStrictEqual({
    configFile: '/home/u/.config/atc/config.json',
    stateDir: '/home/u/.local/state/atc',
    socketPath: '/run/user/1000/atc.sock',
    daemonSocketPath: '/run/user/1000/atc-daemon.sock',
    eventsSocketPath: '/run/user/1000/atc-events.sock',
    daemonPidFile: '/run/user/1000/atc-daemon.pid',
    statusFile: '/home/u/.local/state/atc/status.json',
    dbFile: '/home/u/.local/state/atc/atc.db',
    mcpAuthDBFile: '/home/u/.local/state/atc/mcp-auth.db',
    daemonRecordFile: '/home/u/.local/state/atc/daemon.json',
    restartsDir: '/home/u/.local/state/atc/restarts',
    restartLockFile: '/home/u/.local/state/atc/daemon-restart.lock',
    listingCacheFile: '/home/u/.local/state/atc/listing-cache.json',
  });
});

test('it puts the sockets and the pid file in the state folder when the environment sets no runtime folder', () => {
  const paths = resolvePaths({ HOME: '/home/u' });

  expect([
    paths.socketPath,
    paths.daemonSocketPath,
    paths.eventsSocketPath,
    paths.daemonPidFile,
  ]).toStrictEqual([
    '/home/u/.local/state/atc/atc.sock',
    '/home/u/.local/state/atc/atc-daemon.sock',
    '/home/u/.local/state/atc/atc-events.sock',
    '/home/u/.local/state/atc/atc-daemon.pid',
  ]);
});

test('it reads the home from the environment it is given, not from the process', () => {
  expect(resolvePaths({ HOME: '/elsewhere' }).configFile).toBe(
    '/elsewhere/.config/atc/config.json',
  );
});
