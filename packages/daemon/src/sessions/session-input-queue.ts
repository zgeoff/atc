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
