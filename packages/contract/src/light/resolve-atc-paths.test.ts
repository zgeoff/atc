import { expect, test } from 'bun:test';
import { resolveAtcPaths } from './resolve-atc-paths';

test('it puts the sockets and the pid file in the runtime folder the environment sets', () => {
  expect(resolveAtcPaths({ HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' })).toStrictEqual({
    configFile: '/home/u/.config/atc/config.json',
    stateDir: '/home/u/.local/state/atc',
    socketPath: '/run/user/1000/atc.sock',
    daemonSocketPath: '/run/user/1000/atc-daemon.sock',
    eventsSocketPath: '/run/user/1000/atc-events.sock',
    daemonPidFile: '/run/user/1000/atc-daemon.pid',
    daemonRecordFile: '/home/u/.local/state/atc/daemon.json',
    statusFile: '/home/u/.local/state/atc/status.json',
  });
});

test('it puts the sockets and the pid file in the state folder when the environment sets no runtime folder', () => {
  const paths = resolveAtcPaths({ HOME: '/home/u' });

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
  expect(resolveAtcPaths({ HOME: '/elsewhere' }).configFile).toBe(
    '/elsewhere/.config/atc/config.json',
  );
});
