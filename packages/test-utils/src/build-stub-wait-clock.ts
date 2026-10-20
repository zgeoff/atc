export function buildStubWaitClock() {
  const waits: number[] = [];
  let elapsed = 0;

  return {
    waits,
    now: () => elapsed,
    wait: (delayMs: number): Promise<void> => {
      waits.push(delayMs);

      elapsed += delayMs;

      return Promise.resolve();
    },
  };
}
