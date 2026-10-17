// One timer the scheduler started: its delay, what it runs, and whether it
// is still pending, has run, or was cancelled.
interface StubTimer {
  readonly ms: number;
  readonly onTimeout: () => void;
  state: 'pending' | 'ran' | 'cancelled';
}

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
