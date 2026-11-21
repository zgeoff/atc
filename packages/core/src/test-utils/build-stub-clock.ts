import type { Clock } from '@zgeoff/std';
import { createFakeClock } from '@zgeoff/testing/clock';

interface PendingTimer {
  readonly dueAt: number;
  state: 'pending' | 'ran' | 'cancelled';
}

// The kit's fake clock, with a report of each timer still waiting and of every delay asked for,
// which atc's tests assert on, and a stall that moves the time on without running a callback.
export function buildStubClock(startMs: number) {
  const fake = createFakeClock({ startMs });
  const timers: PendingTimer[] = [];
  const delays: number[] = [];

  // the time a stall moved the clock to; the kit's clock catches up on the next advance
  let stalledTo = startMs;

  const now = (): number => Math.max(fake.now(), stalledTo);

  const clock: Pick<Clock, 'now' | 'schedule'> = {
    now,
    schedule: (fire, delayMs) => {
      const timer: PendingTimer = {
        dueAt: now() + Math.max(0, delayMs),
        state: 'pending',
      };

      delays.push(delayMs);
      timers.push(timer);

      const cancel = fake.schedule(
        () => {
          timer.state = 'ran';

          fire();
        },
        Math.max(0, delayMs) + (now() - fake.now()),
      );

      return () => {
        timer.state = timer.state === 'pending' ? 'cancelled' : timer.state;

        cancel();
      };
    },
  };

  return {
    ...clock,
    advance(durationMs: number): void {
      fake.advance(now() - fake.now() + durationMs);
    },

    // moves the time on and runs no callback, as a busy event loop does; the next advance runs
    // the callbacks that fell due, late
    stall(durationMs: number): void {
      stalledTo = now() + durationMs;
    },
    collectPending: (): number[] =>
      timers
        .filter((timer) => timer.state === 'pending')
        .map((timer) => timer.dueAt - now())
        .toSorted((left, right) => left - right),
    collectDelays: (): number[] => [...delays],
  };
}
