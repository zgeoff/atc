import { join } from 'node:path';
import { resolveHomeDir } from './resolve-home-dir';

/**
 * Every file and socket atc keeps outside a checkout. `stateDir` holds the
 * database, the status file, and the restart records; the sockets and the
 * daemon's pid file sit in `XDG_RUNTIME_DIR` when it is set, else in
 * `stateDir`. `daemonRecordFile` is written by the running daemon: its pid
 * and the socket paths it listens on, for a client whose environment
 * computes other socket paths. `restartsDir` holds the run logs of
 * `atc daemon restart` and the record of the last finished restart, and
 * `restartLockFile` admits one restart at a time.
 */
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
  readonly legacyFleetFile: string;
  readonly daemonRecordFile: string;
  readonly restartsDir: string;
  readonly restartLockFile: string;
}

/**
 * The paths an environment gives: the home from `HOME` and the runtime
 * folder from `XDG_RUNTIME_DIR`. It reads nothing else and touches no file.
 */
export function resolvePaths(env: Readonly<Record<string, string | undefined>>): Paths {
  const home = resolveHomeDir(env);
  const stateDir = join(home, '.local', 'state', 'atc');
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
    legacyFleetFile: join(stateDir, 'fleet.json'),
    daemonRecordFile: join(stateDir, 'daemon.json'),
    restartsDir: join(stateDir, 'restarts'),
    restartLockFile: join(stateDir, 'daemon-restart.lock'),
  };
}
