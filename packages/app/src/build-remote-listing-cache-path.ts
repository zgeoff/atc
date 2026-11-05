import { dirname, join } from 'node:path';

export function buildRemoteListingCachePath(localCacheFile: string, daemonName: string): string {
  return join(dirname(localCacheFile), `listing-cache-${daemonName}.json`);
}
