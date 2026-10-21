import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';

export interface EventSignal {
  generation: number;

  disposed: boolean;

  readonly emit: () => void;
  readonly waitForNext: (since: number, timeoutMs: number) => Promise<void>;
  readonly countWaiters: () => number;
  readonly dispose: () => void;
}

// The clock that times each wait's timeout.
export function createEventSignal(clock: Clock = systemClock): EventSignal {
  const waiters = new Set<() => void>();

  const drainWaiters = (): void => {
    for (const wake of waiters) {
      wake();
    }

    waiters.clear();
  };

  const signal: EventSignal = {
    generation: 0,

    disposed: false,

    emit: () => {
      signal.generation += 1;

      drainWaiters();
    },

    waitForNext: (since, timeoutMs) => {
      if (signal.disposed || signal.generation !== since || timeoutMs <= 0) {
        return Promise.resolve();
      }

      const deferred = Promise.withResolvers<void>();

      // Holds the timer's cancel once it is scheduled.
      let cancel: (() => void) | null = null;

      const onWake = () => {
        cancel?.();
        waiters.delete(onWake);
        deferred.resolve();
      };

      cancel = clock.schedule(onWake, timeoutMs);

      waiters.add(onWake);

      return deferred.promise;
    },

    countWaiters: () => waiters.size,

    dispose: () => {
      signal.disposed = true;
      signal.generation += 1;

      drainWaiters();
    },
  };

  return signal;
}
