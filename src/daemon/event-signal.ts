import { systemClock } from '../shared/system-clock';
import type { Clock } from '../shared/system-clock';

/**
 * Wakes long-polling readers when the event trail grows. A reader notes the
 * signal's count before it queries and waits from that count, so an event
 * recorded between the query and the wait is never missed.
 */
export class EventSignal {
  generation = 0;

  disposed = false;

  private readonly waiters = new Set<() => void>();

  private readonly clock: Clock;

  // The clock that times each wait's timeout.
  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  emit(): void {
    this.generation += 1;

    this.drainWaiters();
  }

  waitForNext(since: number, timeoutMs: number): Promise<void> {
    if (this.disposed || this.generation !== since || timeoutMs <= 0) {
      return Promise.resolve();
    }

    const deferred = Promise.withResolvers<void>();

    // Holds the timer's cancel once it is scheduled.
    let cancel: (() => void) | null = null;

    const onWake = () => {
      cancel?.();
      this.waiters.delete(onWake);
      deferred.resolve();
    };

    cancel = this.clock.schedule(onWake, timeoutMs);

    this.waiters.add(onWake);

    return deferred.promise;
  }

  countWaiters(): number {
    return this.waiters.size;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;

    this.drainWaiters();
  }

  private drainWaiters(): void {
    for (const wake of this.waiters) {
      wake();
    }

    this.waiters.clear();
  }
}
