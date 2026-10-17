import type { Clock } from '@atc/core';

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
