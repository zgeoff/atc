/**
 * A clock for a polling wait that moves only when the wait waits it out:
 * `now` starts at zero, and `wait` records the milliseconds it was asked to
 * wait in `waits`, moves `now` forward by them, and resolves at once. A
 * deadline then passes after a known number of attempts, with no real time
 * spent.
 */
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
