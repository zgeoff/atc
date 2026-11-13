import type { RemoteDaemon } from '@atc/config';
import type { LifecycleHost } from '@atc/lifecycle';
import type { TUIDaemon } from '@atc/tui';
import { bootRemoteDaemonClient } from './boot-remote-daemon-client';
import { buildRemoteListingCachePath } from './build-remote-listing-cache-path';
import { openListingCache } from './open-listing-cache';
import { toDaemonLinkFailureError } from './to-daemon-link-failure-error';

// The TUI's entry for a daemon from the config's `daemons` map: a boot that acts as the entry's
// principal and rejects with the failure's kind, and a listing cache of the daemon's own, so the
// remote host's listings never mix with the local ones.
export function createRemoteDaemonEntry(
  host: LifecycleHost,
  daemon: RemoteDaemon,
): Extract<TUIDaemon, { readonly name: string }> {
  return {
    name: daemon.name,
    bootDaemon: async (options) => {
      try {
        return await bootRemoteDaemonClient(daemon, host.invocation.readBuild(), options);
      } catch (error) {
        throw toDaemonLinkFailureError(error);
      }
    },
    listingCache: openListingCache(
      buildRemoteListingCachePath(host.paths.listingCacheFile, daemon.name),
    ),
  };
}
