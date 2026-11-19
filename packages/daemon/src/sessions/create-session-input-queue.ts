export interface SessionInputQueue {
  readonly schedule: (task: () => Promise<unknown> | void) => void;
}

export function createSessionInputQueue(): SessionInputQueue {
  const pending: (() => Promise<unknown> | void)[] = [];
  let draining = false;

  const drain = async (): Promise<void> => {
    draining = true;

    for (let task = pending.shift(); task !== undefined; task = pending.shift()) {
      // Each task reports its own failure to the request that scheduled it.
      // The queue swallows errors so one failed write does not stop the later ones.
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
