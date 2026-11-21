import type { DaemonClient } from '@atc/protocol/client';
import type { DaemonName } from '../fleet/session-key';

interface ReplayLinks {
  readonly clientFor: (daemon: DaemonName) => Pick<DaemonClient, 'connection'> | null;
}

// A daemon that lists full-replay sends the session's whole emulator state as replay events;
// any other sends the visible screen as output.
export function pickReplay(links: ReplayLinks, daemon: DaemonName): 'screen' | 'full' {
  try {
    const features = links.clientFor(daemon)?.connection.hello.features ?? [];

    return features.includes('full-replay') ? 'full' : 'screen';
  } catch {
    return 'screen';
  }
}
