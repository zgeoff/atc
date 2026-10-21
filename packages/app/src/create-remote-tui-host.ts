import { dirname, join } from 'node:path';
import type { RemoteDaemon } from '@atc/config';
import { loadConfig } from '@atc/config';
import type { LifecycleHost } from '@atc/lifecycle';
import { logClientEvent } from '@atc/lifecycle';
import type { TUIHost } from '@atc/tui';
import { bootRemoteDaemonClient } from './boot-remote-daemon-client';
import { openListingCache } from './open-listing-cache';
import { SHIPPED_HARNESS_PLUGINS } from './plugins/shipped-harness-plugins';

export function createRemoteTUIHost(host: LifecycleHost, daemon: RemoteDaemon): TUIHost {
  return {
    bootDaemon: (options) => bootRemoteDaemonClient(daemon, host.invocation.readBuild(), options),
    restartDaemon: () =>
      Promise.reject(
        new Error(`daemon '${daemon.name}' runs on another host; restart it on that host`),
      ),
    logEvent: logClientEvent,
    readConfig: () => loadConfig(SHIPPED_HARNESS_PLUGINS),

    // a cache of the daemon's own, so the remote host's listings never mix with
    // the local ones
    listingCache: openListingCache(
      join(dirname(host.paths.listingCacheFile), `listing-cache-${daemon.name}.json`),
    ),
    daemonName: daemon.name,
  };
}
