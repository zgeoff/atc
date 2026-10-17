export function buildStubWaitClock() {
  const waits: number[] = [];
  let elapsed = 0;

  return {
    waits,
    now: () => elapsed,
    wait: (ms: number): Promise<void> => {
      waits.push(ms);

      elapsed += ms;

      return Promise.resolve();
    },
  };
}
