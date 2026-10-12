/**
 * The time and the timers a module reads, so a test can step them. `now`
 * returns milliseconds since the epoch; `schedule` runs the callback once
 * after the delay and returns a function that cancels it, which does
 * nothing once the callback has run.
 */
export interface Clock {
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

/**
 * The wall clock and the runtime's own timers.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);

    return () => {
      clearTimeout(timer);
    };
  },
};
