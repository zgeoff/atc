/**
 * Wakes long-polling readers when the event trail grows. A reader captures
 * `generation` before it queries and passes it to `waitForNext`, so an event
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

    const resolveWait = () => {
      clearTimeout(timer);

      this.waiters.delete(resolveWait);
      deferred.resolve();
    };

    const timer = setTimeout(resolveWait, timeoutMs);

    this.waiters.add(resolveWait);

    return deferred.promise;
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
