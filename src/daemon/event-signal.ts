/**
 * Wakes long-polling readers when the event trail grows. A reader notes the
 * signal's count before it queries and waits from that count, so an event
 * recorded between the query and the wait is never missed.
 */
export class EventSignal {
  generation = 0;

  disposed = false;

  private readonly waiters = new Set<() => void>();

  emit(): void {
    this.generation += 1;

    this.drainWaiters();
  }

  waitForNext(since: number, timeoutMs: number): Promise<void> {
    if (this.disposed || this.generation !== since || timeoutMs <= 0) {
      return Promise.resolve();
    }

    const deferred = Promise.withResolvers<void>();

    const onWake = () => {
      clearTimeout(timer);

      this.waiters.delete(onWake);
      deferred.resolve();
    };

    const timer = setTimeout(onWake, timeoutMs);

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
