import type { Clock } from '@zgeoff/std';
import { systemClock } from '@zgeoff/std';

export interface EventSignal {
  generation: number;

  disposed: boolean;

  readonly emit: () => void;
  readonly waitForNext: (since: number, timeoutMs: number) => Promise<void>;
  readonly countWaiters: () => number;
  readonly dispose: () => void;
}

export function createEventSignal(
  clock: Pick<Clock, 'now' | 'schedule'> = systemClock,
): EventSignal {
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
