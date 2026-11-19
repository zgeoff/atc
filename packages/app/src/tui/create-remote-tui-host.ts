import type { RemoteDaemon } from '@atc/config';
import { loadConfig } from '@atc/config';
import type { LifecycleHost } from '@atc/lifecycle';
import { logClientEvent } from '@atc/lifecycle';
import type { TUIHost } from '@atc/tui';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { createRemoteDaemonEntry } from '../remote-daemon/create-remote-daemon-entry';

export function createRemoteTUIHost(host: LifecycleHost, daemon: RemoteDaemon): TUIHost {
  return {
    logEvent: logClientEvent,
    readConfig: () => loadConfig(SHIPPED_HARNESS_PLUGINS),
    daemons: [createRemoteDaemonEntry(host, daemon)],
  };
}
