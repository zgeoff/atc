import type { HarnessFate } from '@atc/plugin-api';
import type { ContainerInfo } from '../engine/types';

// A session with no container, or an exited one from an earlier boot, is lost. A container that
// runs or is paused is kept. An exited container of this boot says nothing: its harness exited
// by itself.
export function collectHarnessFates(
  sessions: readonly string[],
  containers: ReadonlyMap<string, ContainerInfo>,
  currentBoot: string,
): Map<string, HarnessFate> {
  const fates = new Map<string, HarnessFate>();

  for (const session of sessions) {
    const container = containers.get(session);

    if (container === undefined) {
      fates.set(session, 'lost');
    } else if (
      container.status === 'running' ||
      container.status === 'paused' ||
      container.status === 'restarting'
    ) {
      fates.set(session, 'kept');
    } else if (container.labels['atc.boot'] !== currentBoot) {
      fates.set(session, 'lost');
    }
  }

  return fates;
}
