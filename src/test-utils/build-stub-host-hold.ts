/**
 * A host operation a test can hold open, for a host preparation or sleep
 * that must stay in flight while the test changes something. Unarmed, the
 * operation resolves at once, so the arrange steps before the hold pass
 * through. Once armed, the next call resolves `entered` and every call
 * waits until `release`; after the release, calls resolve at once again.
 */
export function buildStubHostHold() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let armed = false;

  return {
    hold: (): Promise<void> => {
      if (!armed) {
        return Promise.resolve();
      }

      entered.resolve();

      return released.promise;
    },
    arm: () => {
      armed = true;
    },
    entered: entered.promise,
    release: () => {
      released.resolve();
    },
  };
}
