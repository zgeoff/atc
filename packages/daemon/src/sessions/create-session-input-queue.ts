export interface SessionInputQueue {
  readonly schedule: (task: () => Promise<unknown> | void) => void;
}

export function createSessionInputQueue(): SessionInputQueue {
  const pending: (() => Promise<unknown> | void)[] = [];
  let draining = false;

  const drain = async (): Promise<void> => {
    draining = true;

    for (let task = pending.shift(); task !== undefined; task = pending.shift()) {
      // A failed write belongs to the request that scheduled it, which
      // answers for it; the queue only keeps going.
      try {
        await task();
      } catch {}
    }

    draining = false;
  };

  return {
    schedule: (task) => {
      pending.push(task);

      if (!draining) {
        void drain();
      }
    },
  };
}
