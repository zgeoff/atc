import { bootDaemonClient } from '@atc/lifecycle/boot-daemon';
import type { LifecycleHost } from '@atc/lifecycle/lifecycle-host';
import { logClientEvent } from '@atc/lifecycle/log-client-event';
import { restartDaemonAtSocket } from '@atc/lifecycle/restart-daemon-at-socket';
import type { TUIHost } from './client/tui-host';

/**
 * The host the TUI runs against in this process: boots and restarts through
 * the lifecycle host, the same restart step `atc daemon restart` takes, and
 * logs to the client event log.
 */
export function buildTUIHost(host: LifecycleHost): TUIHost {
  return {
    bootDaemon: (options) => bootDaemonClient(host, options),
    restartDaemon: (socketPath) => restartDaemonAtSocket(host, socketPath),
    logEvent: logClientEvent,
  };
}
