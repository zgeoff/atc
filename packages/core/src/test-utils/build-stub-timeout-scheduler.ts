// One timer the scheduler started: its delay, what it runs, and whether it
// is still pending, has run, or was cancelled.
interface StubTimer {
  readonly delayMs: number;
  readonly onTimeout: () => void;
  state: 'pending' | 'ran' | 'cancelled';
}

export function buildStubTimeoutScheduler() {
  const timers: StubTimer[] = [];

  return {
    schedule: (onTimeout: () => void, delayMs: number): (() => void) => {
      const timer: StubTimer = { delayMs, onTimeout, state: 'pending' };

      timers.push(timer);

      return () => {
        timer.state = timer.state === 'pending' ? 'cancelled' : timer.state;
      };
    },
    runTimer: (delayMs: number): void => {
      const timer = timers.find(
        (candidate) => candidate.state === 'pending' && candidate.delayMs === delayMs,
      );

      if (timer === undefined) {
        throw new Error(`no pending timer of ${delayMs} ms`);
      }

      timer.state = 'ran';

      timer.onTimeout();
    },
    collectDelays: (): number[] => timers.map((timer) => timer.delayMs),
    collectPendingDelays: (): number[] =>
      timers.filter((timer) => timer.state === 'pending').map((timer) => timer.delayMs),
  };
}
