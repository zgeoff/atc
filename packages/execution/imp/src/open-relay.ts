import type { ImpRelayConnection } from './imp-port';

// How the client hands over a guest connection: the daemon accepts it with
// its handlers and gets the relay back.
type RelayAccept = (
  handlers: Readonly<{
    onData: (data: Uint8Array) => void;
    onEof: () => void;
    onClose: (lost: boolean) => void;
  }>,
) => Readonly<{
  send: (data: Uint8Array) => boolean;
  waitForRoom: () => Promise<void>;
  close: () => void;
}>;

// Takes a guest connection at once, handing its bytes and its close to the
// listeners the relay's owner adds.
export function openRelay(accept: RelayAccept): ImpRelayConnection {
  const dataListeners: ((data: Uint8Array) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const endListeners: (() => void)[] = [];

  const relay = accept({
    onData: (data) => {
      for (const listener of dataListeners) {
        listener(data);
      }
    },
    onEof: () => {
      for (const listener of endListeners) {
        listener();
      }
    },
    onClose: () => {
      for (const listener of closeListeners) {
        listener();
      }
    },
  });

  return {
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    onEnd: (listener) => {
      endListeners.push(listener);
    },

    // A send past the relay's window still queues the bytes, so only the
    // next write waits; a closed relay takes bytes and drops them.
    write: async (data) => {
      if (!relay.send(data)) {
        await relay.waitForRoom();
      }
    },
    close: () => {
      relay.close();
    },
  };
}
