import type { Clock } from '@atc/core';
import type { StateStore } from '@atc/store';

const EVENT_SWEEP_MS = 60 * 60 * 1000;

interface EventSweepDeps {
  readonly store: Pick<StateStore, 'removeExpiredEvents'>;

  // The clock the cutoff is read from.
  readonly clock: Clock;

  // The clock each sweep is scheduled on.
  readonly sweepClock: Clock;
}

export async function startEventSweep(deps: EventSweepDeps): Promise<() => void> {
  await tryRemoveExpiredEvents(deps);

  let stop: (() => void) | null = null;

  const scheduleSweep = () => {
    stop = deps.sweepClock.schedule(() => {
      // the next sweep is scheduled before this one runs, so a failed sweep never stops the timer
      scheduleSweep();
      void tryRemoveExpiredEvents(deps);
    }, EVENT_SWEEP_MS);
  };

  scheduleSweep();

  return () => {
    stop?.();
  };
}

// A trail row is kept this long after it was recorded, and the sweep that
// drops older ones, along with the rows the trail reads leave out, runs this
// often.
const EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// A sweep that fails leaves the rows for the next one.
async function tryRemoveExpiredEvents(deps: EventSweepDeps): Promise<boolean> {
  try {
    await deps.store.removeExpiredEvents(deps.clock.now() - EVENT_TTL_MS);
  } catch {
    return false;
  }

  return true;
}
