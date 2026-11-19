type ChannelOpener<Address, Channel> = (address: Address) => Promise<Channel>;

interface StubChannelOpenerOptions {
  // The position of the dial to hold, counting from 1; no dial is held
  // without it.
  readonly holdDial?: number;
}

export function buildStubChannelOpener<Address, Channel>(
  openers: readonly [ChannelOpener<Address, Channel>, ...ChannelOpener<Address, Channel>[]],
  options: StubChannelOpenerOptions = {},
) {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let opened = 0;

  return {
    open: async (address: Address): Promise<Channel> => {
      opened++;

      const opener = openers[Math.min(opened, openers.length) - 1] ?? openers[0];

      if (opened === options.holdDial) {
        reached.resolve();

        await released.promise;
      }

      return opener(address);
    },
    countOpened: (): number => opened,
    waitForHeld: (): Promise<void> => reached.promise,
    releaseHeld: (): void => {
      released.resolve();
    },
  };
}
