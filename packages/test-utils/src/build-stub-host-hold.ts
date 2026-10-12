/**
 * A host operation a test can hold open, for a host preparation or sleep
 * that must stay in flight while the test changes something: a test passes
 * `waitForRelease` as the operation. Before `startHold`, the operation
 * resolves at once, so the arrange steps before the hold pass through.
 * After it, the next call resolves `entered` and every call waits until
 * `release`; after the release, calls resolve at once again.
 */
export function buildStubHostHold() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let armed = false;

  return {
    waitForRelease: (): Promise<void> => {
      if (!armed) {
        return Promise.resolve();
      }

      entered.resolve();

      return released.promise;
    },
    startHold: () => {
      armed = true;
    },
    entered: entered.promise,
    release: () => {
      released.resolve();
    },
  };
}
