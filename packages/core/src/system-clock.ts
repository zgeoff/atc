export interface Clock {
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);

    return () => {
      clearTimeout(timer);
    };
  },
};
