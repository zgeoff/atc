import { join } from 'node:path';
import { resolveHomeDir } from './resolve-home-dir';
import { resolveStateDir } from './resolve-state-dir';

export interface AtcPaths {
  readonly configFile: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly daemonSocketPath: string;
  readonly eventsSocketPath: string;
  readonly daemonPidFile: string;
  readonly daemonRecordFile: string;
  readonly statusFile: string;
}

export function resolveAtcPaths(env: Readonly<Record<string, string | undefined>>): AtcPaths {
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
    daemonRecordFile: join(stateDir, 'daemon.json'),
    statusFile: join(stateDir, 'status.json'),
  };
}
