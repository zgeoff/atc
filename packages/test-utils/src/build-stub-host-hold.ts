export function buildStubHostHold() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let armed = false;

  return {
    waitForRelease: (): Promise<void> => {
      // Before the hold starts, calls pass straight through, so the arrange steps
      // run unhindered.
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
