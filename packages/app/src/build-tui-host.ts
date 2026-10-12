import type { ATCInvocation } from '@atc/lifecycle/atc-invocation';
import { bootDaemonClient } from '@atc/lifecycle/boot-daemon';
import { logClientEvent } from '@atc/lifecycle/log-client-event';
import { readManagedDaemonUnit } from '@atc/lifecycle/read-managed-daemon-unit';
import { restartManagedDaemon } from '@atc/lifecycle/restart-managed-daemon';
import type { TUIHost } from './client/tui-host';

/**
 * The host the TUI runs against in this process: boots through this build's
 * invocation, the user unit lookup and restart, and the client event log.
 */
export function buildTUIHost(invocation: ATCInvocation): TUIHost {
  return {
    bootDaemon: (options) => bootDaemonClient(invocation, options),
    isDaemonManaged: () => readManagedDaemonUnit() !== null,
    restartManagedDaemon: () => restartManagedDaemon(),
    logEvent: logClientEvent,
  };
}
