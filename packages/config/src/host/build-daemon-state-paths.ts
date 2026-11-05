import { dirname, join } from 'node:path';

export interface DaemonStatePaths {
  readonly recordFile: string;
  readonly lockFile: string;
}

export function buildDaemonStatePaths(dbPath: string): DaemonStatePaths {
  const stateDir = dirname(dbPath);

  return { recordFile: join(stateDir, 'daemon.json'), lockFile: join(stateDir, 'daemon.lock') };
}
