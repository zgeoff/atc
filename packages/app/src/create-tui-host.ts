import { loadConfig } from '@atc/config';
import { bootDaemonClient, logClientEvent, restartDaemonAtSocket } from '@atc/lifecycle';
import type { LifecycleHost } from '@atc/lifecycle';
import type { TUIHost } from '@atc/tui';
import { openListingCache } from './open-listing-cache';
import { SHIPPED_HARNESS_PLUGINS } from './plugins/shipped-harness-plugins';

export function createTUIHost(host: LifecycleHost): TUIHost {
  return {
    bootDaemon: (options) => bootDaemonClient(host, options),
    restartDaemon: (socketPath) => restartDaemonAtSocket(host, socketPath),
    logEvent: logClientEvent,
    readConfig: () => loadConfig(SHIPPED_HARNESS_PLUGINS),
    listingCache: openListingCache(host.paths.listingCacheFile),
    daemonName: null,
  };
}
