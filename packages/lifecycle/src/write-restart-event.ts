import type { DaemonClient } from '@atc/protocol/client';
import type { RestartResult } from '@atcx/contract';
import { buildHostDaemonPaths } from './build-host-daemon-paths';
import type { LifecycleHost } from './lifecycle-host';
import { readDaemonSocketPaths } from './read-daemon-socket-paths';

type RestartEventOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'no_daemon' }
  | { readonly kind: 'failed'; readonly reason: string };

const SEND_DEADLINE_MS = 5000;

export async function writeRestartEvent(
  host: LifecycleHost,
  result: RestartResult,
): Promise<RestartEventOutcome> {
  try {
    const probe = await host.openDaemon(
      readDaemonSocketPaths(buildHostDaemonPaths(host)),
      {
        build: host.invocation.readBuild(),
        deadline: host.clock.now() + SEND_DEADLINE_MS,
        clock: host.clock,
      },
      (client: Readonly<DaemonClient>) => client.sendRequest('daemon.restarted', { result }),
    );

    if (probe === null) {
      return { kind: 'no_daemon' };
    }

    return probe.kind === 'ok' ? { kind: 'sent' } : { kind: 'failed', reason: probe.message };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
