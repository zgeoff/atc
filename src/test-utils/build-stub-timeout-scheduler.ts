// One timer the scheduler started: its delay, what it runs, and whether it
// is still pending, has run, or was cancelled.
interface StubTimer {
  readonly ms: number;
  readonly onTimeout: () => void;
  state: 'pending' | 'ran' | 'cancelled';
}

/**
 * A timeout scheduler for code that takes one in place of `setTimeout`: no
 * timer ever runs on its own. `schedule` records the timer and returns what
 * cancels it, as a real scheduler does; `runTimer` runs the oldest pending
 * timer of the given delay and throws when none is pending, so a test both
 * proves the code asked for that delay and moves time past it.
 * `collectDelays` returns the delay of every timer in the order the code
 * started them, and `collectPendingDelays` those neither run nor cancelled.
 */
export function buildStubTimeoutScheduler() {
  const timers: StubTimer[] = [];

  return {
    schedule: (onTimeout: () => void, ms: number): (() => void) => {
      const timer: StubTimer = { ms, onTimeout, state: 'pending' };

      timers.push(timer);

      return () => {
        timer.state = timer.state === 'pending' ? 'cancelled' : timer.state;
      };
    },
    runTimer: (ms: number): void => {
      const timer = timers.find(
        (candidate) => candidate.state === 'pending' && candidate.ms === ms,
      );

      if (timer === undefined) {
        throw new Error(`no pending timer of ${ms} ms`);
      }

      timer.state = 'ran';

      timer.onTimeout();
    },
    collectDelays: (): number[] => timers.map((timer) => timer.ms),
    collectPendingDelays: (): number[] =>
      timers.filter((timer) => timer.state === 'pending').map((timer) => timer.ms),
  };
}
