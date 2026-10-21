import { rmSync } from 'node:fs';
import type { ImpForwardEnd, ImpRelayConnection, ImpReverseForward } from '../imp-port';
import { mergeTail } from './merge-tail';

// The reverse forwards impd opens from a guest socket to the daemon, the
// connections they relay, and the faults a test puts on them.
export interface StubImpForwards {
  readonly openReverseForward: (
    name: string,
    guestPath: string,
    onConnection: (connection: ImpRelayConnection) => void,
  ) => ImpReverseForward;

  readonly stopRelays: () => void;

  // impd ends a forward when its tunnel socket closes or it loses the guest.
  readonly stopForwards: (end: Exclude<ImpForwardEnd, { kind: 'stopped' }>) => void;

  // Stops every forward the stand-in holds.
  readonly stop: () => void;

  readonly startRelayRefusal: () => void;
  readonly stopRelayRefusal: () => void;

  // What the daemon writes still reaches the guest.
  readonly startGuestByteDrop: () => void;

  readonly stopGuestByteDrop: () => void;

  // How many bytes guests wrote that the drop threw away.
  readonly countDroppedGuestBytes: () => number;
}

interface StubRelay {
  readonly dataListeners: ((data: Uint8Array) => void)[];
  readonly closeListeners: (() => void)[];
  readonly endListeners: (() => void)[];

  // Bytes a write handed over that the socket has not taken yet, and the
  // writes waiting for them to go.
  unsent: Uint8Array;
  readonly roomWaiters: (() => void)[];
}

interface StubImpForwardsOptions {
  readonly calls: string[];
}

export function createStubImpForwards(deps: StubImpForwardsOptions): StubImpForwards {
  // Whether every reverse forward closes each new guest connection at once.
  let refusingRelays = false;

  // Whether every relayed connection drops what the guest writes, while
  // what the daemon writes still reaches the guest.
  let droppingGuestBytes = false;

  // How many guest bytes the drop has thrown away.
  let droppedGuestBytes = 0;

  const forwards = new Set<{
    stop: () => void;
    stopRelays: () => void;
    end: (end: ImpForwardEnd) => void;
  }>();

  const calls = deps.calls;

  return {
    openReverseForward: (name, guestPath, onConnection) => {
      calls.push(`reverse ${name} ${guestPath}`);

      const server = Bun.listen<StubRelay>({
        unix: guestPath,
        socket: {
          open: (socket) => {
            const relay: StubRelay = {
              dataListeners: [],
              closeListeners: [],
              endListeners: [],
              unsent: new Uint8Array(0),
              roomWaiters: [],
            };

            socket.data = relay;

            if (refusingRelays) {
              socket.end();

              return;
            }

            relays.add(socket);

            onConnection({
              onData: (listener) => {
                relay.dataListeners.push(listener);
              },
              onClose: (listener) => {
                relay.closeListeners.push(listener);
              },
              onEnd: (listener) => {
                relay.endListeners.push(listener);
              },

              // A socket write takes what fits and drops the rest, so the
              // remainder waits for the next drain.
              write: async (data) => {
                relay.unsent = mergeTail(relay.unsent, data, Number.POSITIVE_INFINITY);
                relay.unsent = relay.unsent.subarray(socket.write(relay.unsent));

                if (relay.unsent.length > 0) {
                  const room = Promise.withResolvers<void>();

                  relay.roomWaiters.push(room.resolve);

                  await room.promise;
                }
              },
              close: () => {
                socket.end();
              },
            });
          },
          data: (socket, buf) => {
            if (droppingGuestBytes) {
              droppedGuestBytes += buf.length;

              return;
            }

            for (const listener of socket.data.dataListeners) {
              listener(new Uint8Array(buf));
            }
          },
          end: (socket) => {
            for (const listener of socket.data.endListeners) {
              listener();
            }
          },
          drain(socket) {
            const relay = socket.data;

            relay.unsent = relay.unsent.subarray(socket.write(relay.unsent));

            if (relay.unsent.length === 0) {
              for (const resolve of relay.roomWaiters.splice(0)) {
                resolve();
              }
            }
          },
          close: (socket) => {
            relays.delete(socket);

            for (const resolve of socket.data.roomWaiters.splice(0)) {
              resolve();
            }

            for (const listener of socket.data.closeListeners) {
              listener();
            }
          },
          error() {},
        },
      });

      const relays = new Set<{ readonly end: () => void }>();

      const ended = Promise.withResolvers<ImpForwardEnd>();

      // The first end counts, as each end stops the listener and removes the
      // guest socket.
      const forward = {
        end: (end: ImpForwardEnd) => {
          if (!forwards.delete(forward)) {
            return;
          }

          server.stop(true);

          rmSync(guestPath, { force: true });

          ended.resolve(end);
        },
        stop: () => {
          forward.end({ kind: 'stopped' });
        },
        stopRelays: () => {
          for (const relay of relays) {
            relay.end();
          }
        },
      };

      forwards.add(forward);

      return { listening: Promise.resolve(), ended: ended.promise, stop: forward.stop };
    },

    stopRelays: () => {
      for (const forward of forwards) {
        forward.stopRelays();
      }
    },

    stopForwards: (end) => {
      for (const forward of forwards) {
        forward.end(end);
      }
    },

    stop: () => {
      for (const forward of forwards) {
        forward.stop();
      }
    },

    startRelayRefusal: () => {
      refusingRelays = true;
    },

    stopRelayRefusal: () => {
      refusingRelays = false;
    },

    startGuestByteDrop: () => {
      droppingGuestBytes = true;
    },

    stopGuestByteDrop: () => {
      droppingGuestBytes = false;
    },

    countDroppedGuestBytes: () => droppedGuestBytes,
  };
}
