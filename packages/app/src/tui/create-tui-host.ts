import { loadConfig } from '@atc/config';
import { bootDaemonClient, logClientEvent, restartDaemonAtSocket } from '@atc/lifecycle';
import type { LifecycleHost } from '@atc/lifecycle';
import type { TUIHost } from '@atc/tui';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { createRemoteDaemonEntry } from '../remote-daemon/create-remote-daemon-entry';
import { openListingCache } from './open-listing-cache';

export function createTUIHost(host: LifecycleHost): TUIHost {
  const config = loadConfig(SHIPPED_HARNESS_PLUGINS);

  return {
    logEvent: logClientEvent,
    readConfig: () => loadConfig(SHIPPED_HARNESS_PLUGINS),
    daemons: [
      {
        name: null,
        bootDaemon: (options) => bootDaemonClient(host, options),
        restartDaemon: (socketPath) => restartDaemonAtSocket(host, socketPath),
        listingCache: openListingCache(host.paths.listingCacheFile),
      },
      ...[...config.daemons.values()].map((daemon) => createRemoteDaemonEntry(host, daemon)),
    ],
  };
}
