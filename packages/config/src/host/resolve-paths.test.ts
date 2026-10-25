import { expect, test } from 'bun:test';
import { resolvePaths } from './resolve-paths';

test('it adds the internal state files to the paths a client reads', () => {
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
