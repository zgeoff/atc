import type { Clock } from '@atc/core';

/**
 * A clock whose time moves only by the delays it is asked to wait, for a
 * polling wait whose deadline lies far ahead: `now` starts at zero, and a
 * scheduled callback runs on the next turn of the event loop, after `now`
 * moves forward to the time it was due. A wait of seconds then passes in
 * as many event-loop turns as it polls, with no real time spent. A
 * cancelled callback never runs and never moves the time.
 */
export function buildStubSkipClock(): Clock {
  let time = 0;

  return {
    now: () => time,
    schedule: (fire, delayMs) => {
      const dueAt = time + delayMs;

      const timer = setTimeout(() => {
        time = Math.max(time, dueAt);

        fire();
      }, 0);

      return () => {
        clearTimeout(timer);
      };
    },
  };
}
