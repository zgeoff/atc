import type { HarnessFate } from '@atc/plugin-api';
import type { ContainerInfo } from '../engine/types';

// The daemon asks only about sleeping sessions, whose containers a kill paused. A paused harness
// cannot exit by itself, so an exited container means a reboot or an Engine restart stopped it.
export function collectHarnessFates(
  sessions: readonly string[],
  containers: ReadonlyMap<string, ContainerInfo>,
): Map<string, HarnessFate> {
  const fates = new Map<string, HarnessFate>();

  for (const session of sessions) {
    const container = containers.get(session);

    const isHeld =
      container !== undefined &&
      (container.status === 'running' ||
        container.status === 'paused' ||
        container.status === 'restarting');

    const fate: HarnessFate = isHeld ? 'kept' : 'lost';

    fates.set(session, fate);
  }

  return fates;
}
