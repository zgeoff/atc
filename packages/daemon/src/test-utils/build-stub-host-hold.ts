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
