import type { Clock } from '@atc/core';
import type { StateStore } from '@atc/store';

const EVENT_SWEEP_MS = 60 * 60 * 1000;

interface EventSweepDeps {
  readonly store: Pick<StateStore, 'removeExpiredEvents'>;

  readonly clock: Clock;

  readonly sweepClock: Clock;
}

export async function startEventSweep(deps: EventSweepDeps): Promise<() => void> {
  await tryRemoveExpiredEvents(deps);

  let stop: (() => void) | null = null;

  const scheduleSweep = () => {
    stop = deps.sweepClock.schedule(() => {
      scheduleSweep();
      void tryRemoveExpiredEvents(deps);
    }, EVENT_SWEEP_MS);
  };

  scheduleSweep();

  return () => {
    stop?.();
  };
}

const EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function tryRemoveExpiredEvents(deps: EventSweepDeps): Promise<boolean> {
  try {
    await deps.store.removeExpiredEvents(deps.clock.now() - EVENT_TTL_MS);
  } catch {
    return false;
  }

  return true;
}
