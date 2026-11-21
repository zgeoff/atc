import type { Clock } from '@zgeoff/std';

export function buildStubSkipClock(): Pick<Clock, 'now' | 'schedule'> {
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
