/**
 * Runs the input writes of one session one task at a time, in the order
 * they arrive. A task scheduled while no other task runs starts at once, so
 * the writes it makes before its first await, or all of them for a task
 * that does not await, go out in the tick its request arrives in. A task
 * that awaits, such as a line that pauses between two writes, holds every
 * later task until it settles, so input that arrives meanwhile waits behind
 * the line and never lands inside it. A task that throws or rejects ends
 * there, and the tasks behind it still run.
 */
export class SessionInputQueue {
  private readonly pending: (() => Promise<unknown> | void)[] = [];

  private draining = false;

  schedule(task: () => Promise<unknown> | void): void {
    this.pending.push(task);

    if (!this.draining) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.draining = true;

    for (let task = this.pending.shift(); task !== undefined; task = this.pending.shift()) {
      // A failed write belongs to the request that scheduled it, which
      // answers for it; the queue only keeps going.
      try {
        await task();
      } catch {}
    }

    this.draining = false;
  }
}
