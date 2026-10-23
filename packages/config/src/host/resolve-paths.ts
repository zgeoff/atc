import { join } from 'node:path';
import type { AtcPaths } from '@atcx/contract/light';
import { resolveAtcPaths } from '@atcx/contract/light';

export interface Paths extends AtcPaths {
  readonly dbFile: string;
  readonly mcpAuthDBFile: string;
  readonly restartsDir: string;
  readonly restartLockFile: string;
  readonly listingCacheFile: string;
}

export function resolvePaths(env: Readonly<Record<string, string | undefined>>): Paths {
  const paths = resolveAtcPaths(env);

  return {
    ...paths,
    dbFile: join(paths.stateDir, 'atc.db'),
    mcpAuthDBFile: join(paths.stateDir, 'mcp-auth.db'),
    restartsDir: join(paths.stateDir, 'restarts'),
    restartLockFile: join(paths.stateDir, 'daemon-restart.lock'),
    listingCacheFile: join(paths.stateDir, 'listing-cache.json'),
  };
}
