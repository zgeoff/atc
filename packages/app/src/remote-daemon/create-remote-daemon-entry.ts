import type { RemoteDaemon } from '@atc/config';
import type { LifecycleHost } from '@atc/lifecycle';
import type { TUIDaemon } from '@atc/tui';
import { toDaemonLinkFailureError } from '../daemon-connection/to-daemon-link-failure-error';
import { buildRemoteListingCachePath } from '../tui/build-remote-listing-cache-path';
import { openListingCache } from '../tui/open-listing-cache';
import { bootRemoteDaemonClient } from './boot-remote-daemon-client';

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
