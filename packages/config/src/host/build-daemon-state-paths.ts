import { join } from 'node:path';

export interface DaemonStatePaths {
  readonly recordFile: string;
  readonly lockFile: string;
}

export function buildDaemonStatePaths(stateDir: string): DaemonStatePaths {
  return { recordFile: join(stateDir, 'daemon.json'), lockFile: join(stateDir, 'daemon.lock') };
}
