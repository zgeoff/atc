type ChannelOpener<Address, Channel> = (address: Address) => Promise<Channel>;

/**
 * A dial function that opens each connection with the opener at the dial's
 * position in the list, and every dial past the end with the last one, so
 * a test can send a first connection to one place and every reconnect to
 * another, or hold one dial until it releases it. `countOpened` returns how
 * many dials it has made.
 */
export function buildStubChannelOpener<Address, Channel>(
  openers: readonly [ChannelOpener<Address, Channel>, ...ChannelOpener<Address, Channel>[]],
) {
  let opened = 0;

  return {
    open: (address: Address): Promise<Channel> => {
      const opener = openers[Math.min(opened, openers.length - 1)] ?? openers[0];

      opened++;

      return opener(address);
    },
    countOpened: (): number => opened,
  };
}
