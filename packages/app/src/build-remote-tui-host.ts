import { dirname, join } from 'node:path';
import type { RemoteDaemon } from '@atc/config';
import type { LifecycleHost } from '@atc/lifecycle';
import { logClientEvent } from '@atc/lifecycle';
import { bootRemoteDaemonClient } from './boot-remote-daemon-client';
import type { TUIHost } from './client/tui-host';

export function buildRemoteTUIHost(host: LifecycleHost, daemon: RemoteDaemon): TUIHost {
  return {
    bootDaemon: (options) => bootRemoteDaemonClient(daemon, host.invocation.readBuild(), options),
    restartDaemon: () =>
      Promise.reject(
        new Error(`daemon '${daemon.name}' runs on another host; restart it on that host`),
      ),
    logEvent: logClientEvent,

    // a cache of the daemon's own, so the remote host's listings never mix with
    // the local ones
    listingCacheFile: join(
      dirname(host.paths.listingCacheFile),
      `listing-cache-${daemon.name}.json`,
    ),
    daemonName: daemon.name,
  };
}
