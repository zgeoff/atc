import { bootDaemonClient, logClientEvent, restartDaemonAtSocket } from '@atc/lifecycle';
import type { LifecycleHost } from '@atc/lifecycle';
import type { TUIHost } from './client/tui-host';

/**
 * The host the TUI runs against in this process: boots and restarts through
 * the lifecycle host, the same restart step `atc daemon restart` takes, and
 * logs to the client event log, and keeps source listings in the state
 * directory.
 */
export function buildTUIHost(host: LifecycleHost): TUIHost {
  return {
    bootDaemon: (options) => bootDaemonClient(host, options),
    restartDaemon: (socketPath) => restartDaemonAtSocket(host, socketPath),
    logEvent: logClientEvent,
    listingCacheFile: host.paths.listingCacheFile,
    daemonName: null,
  };
}
