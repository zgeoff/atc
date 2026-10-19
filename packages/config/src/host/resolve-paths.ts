import { join } from 'node:path';
import { resolveHomeDir } from './resolve-home-dir';
import { resolveStateDir } from './resolve-state-dir';

export interface Paths {
  readonly configFile: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly daemonSocketPath: string;
  readonly eventsSocketPath: string;
  readonly daemonPidFile: string;
  readonly statusFile: string;
  readonly dbFile: string;
  readonly mcpAuthDBFile: string;
  readonly daemonRecordFile: string;
  readonly restartsDir: string;
  readonly restartLockFile: string;
  readonly listingCacheFile: string;
}

export function resolvePaths(env: Readonly<Record<string, string | undefined>>): Paths {
  const home = resolveHomeDir(env);
  const stateDir = resolveStateDir(home);
  const runtimeDir = env['XDG_RUNTIME_DIR'] ?? stateDir;

  return {
    configFile: join(home, '.config', 'atc', 'config.json'),
    stateDir,
    socketPath: join(runtimeDir, 'atc.sock'),
    daemonSocketPath: join(runtimeDir, 'atc-daemon.sock'),
    eventsSocketPath: join(runtimeDir, 'atc-events.sock'),
    daemonPidFile: join(runtimeDir, 'atc-daemon.pid'),
    statusFile: join(stateDir, 'status.json'),
    dbFile: join(stateDir, 'atc.db'),
    mcpAuthDBFile: join(stateDir, 'mcp-auth.db'),
    daemonRecordFile: join(stateDir, 'daemon.json'),
    restartsDir: join(stateDir, 'restarts'),
    restartLockFile: join(stateDir, 'daemon-restart.lock'),
    listingCacheFile: join(stateDir, 'listing-cache.json'),
  };
}
