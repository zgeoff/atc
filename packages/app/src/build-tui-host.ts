import { bootDaemonClient, logClientEvent, restartDaemonAtSocket } from '@atc/lifecycle';
import type { LifecycleHost } from '@atc/lifecycle';
import type { TUIHost } from './client/tui-host';

export function buildTUIHost(host: LifecycleHost): TUIHost {
  return {
    bootDaemon: (options) => bootDaemonClient(host, options),
    restartDaemon: (socketPath) => restartDaemonAtSocket(host, socketPath),
    logEvent: logClientEvent,
    listingCacheFile: host.paths.listingCacheFile,
    daemonName: null,
  };
}
