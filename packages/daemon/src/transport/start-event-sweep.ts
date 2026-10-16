import type { Clock } from '@atc/core';
import type { StateStore } from '@atc/store';

// A trail row is kept this long after it was recorded, and the sweep that
// drops older ones, along with the rows the trail reads leave out, runs this
// often.
const EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EVENT_SWEEP_MS = 60 * 60 * 1000;

interface EventSweepDeps {
  readonly store: Pick<StateStore, 'removeExpiredEvents'>;

  // The clock the cutoff is read from.
  readonly clock: Clock;

  // The clock each sweep is scheduled on.
  readonly sweepClock: Clock;
}

/**
 * Drops the trail rows past their age once, then again on a timer, and
 * returns the call that stops the timer. Each sweep schedules the next
 * before it runs, so a failed sweep leaves the rows for the next one.
 */
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

// A sweep that fails leaves the rows for the next one.
async function tryRemoveExpiredEvents(deps: EventSweepDeps): Promise<boolean> {
  try {
    await deps.store.removeExpiredEvents(deps.clock.now() - EVENT_TTL_MS);
  } catch {
    return false;
  }

  return true;
}
