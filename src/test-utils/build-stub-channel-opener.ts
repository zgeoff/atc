type ChannelOpener<Address, Channel> = (address: Address) => Promise<Channel>;

interface StubChannelOpenerOptions {
  // The position of the dial to hold, counting from 1; no dial is held
  // without it.
  readonly holdDial?: number;
}

/**
 * A dial function that opens each connection with the opener at the dial's
 * position in the list, and every dial past the end with the last one, so
 * a test can send a first connection to one place and every reconnect to
 * another. The dial at `holdDial` waits before it opens: `waitForHeld`
 * resolves once that dial has started, and `releaseHeld` lets it go on.
 * `countOpened` returns how many dials it has made.
 */
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
