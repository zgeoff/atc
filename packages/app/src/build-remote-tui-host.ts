import { dirname, join } from 'node:path';
import type { RemoteDaemon } from '@atc/config/collect-remote-daemons';
import type { LifecycleHost } from '@atc/lifecycle/lifecycle-host';
import { logClientEvent } from '@atc/lifecycle/log-client-event';
import { bootRemoteDaemonClient } from './boot-remote-daemon-client';
import type { TUIHost } from './client/tui-host';

/**
 * The host the TUI runs against when `--daemon` selects a daemon on another
 * host: it connects to that daemon alone and never boots, finds, or
 * restarts a local one. A restart rejects, since the daemon's own host
 * restarts it. Source listings go to a cache file of the daemon's own, so
 * the remote host's listings never mix with the local ones.
 */
export function buildRemoteTUIHost(host: LifecycleHost, daemon: RemoteDaemon): TUIHost {
  return {
    bootDaemon: (options) => bootRemoteDaemonClient(daemon, host.invocation.readBuild(), options),
    restartDaemon: () =>
      Promise.reject(
        new Error(`daemon '${daemon.name}' runs on another host; restart it on that host`),
      ),
    logEvent: logClientEvent,
    listingCacheFile: join(
      dirname(host.paths.listingCacheFile),
      `listing-cache-${daemon.name}.json`,
    ),
    daemonName: daemon.name,
  };
}
