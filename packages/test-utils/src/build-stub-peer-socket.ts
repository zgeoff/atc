import { parsePeerFrame } from './parse-peer-frame';
import type { PeerFrame } from './parse-peer-frame';

// What a response frame answers: its status, headers and decoded body.
export type PeerAnswer = Omit<Extract<PeerFrame, { kind: 'response' }>, 'kind' | 'id'>;

export function buildStubPeerSocket() {
  const decoder = new TextDecoder();
  const waiters = new Map<string, PromiseWithResolvers<PeerAnswer>>();

  let accepting = true;
  let ended = false;
  let refusedWrites = 0;
  let written = '';

  const collectFrames = (): PeerFrame[] =>
    written
      .split('\n')
      .slice(0, -1)
      .map((line) => parsePeerFrame(line));

  return {
    socket: {
      write: (data: Uint8Array): number => {
        // Taking no bytes stands in for a full kernel buffer, so backpressure is a
        // switch instead of a buffer race.
        if (!accepting) {
          refusedWrites += 1;

          return 0;
        }

        written += decoder.decode(data, { stream: true });

        // Frames are parsed only for a pending wait, so a stray line fails
        // the read that looks at it rather than the daemon's write.
        for (const frame of waiters.size === 0 ? [] : collectFrames()) {
          const waiter = waiters.get(frame.id);

          if (waiter !== undefined) {
            waiters.delete(frame.id);

            settleAnswer(waiter, frame);
          }
        }

        return data.length;
      },
      end: () => {
        ended = true;
      },
    },
    setAccepting: (value: boolean) => {
      accepting = value;
    },
    hasEnded: (): boolean => ended,

    // How many writes found the socket taking nothing, so a test can wait
    // for a write that the daemon queued.
    countRefusedWrites: (): number => refusedWrites,
    collectFrames,

    waitForAnswer: (id: string): Promise<PeerAnswer> => {
      const found = collectFrames().find((frame) => frame.id === id);
      const waiter = Promise.withResolvers<PeerAnswer>();

      if (found === undefined) {
        waiters.set(id, waiter);
      } else {
        settleAnswer(waiter, found);
      }

      return waiter.promise;
    },
  };
}

// The first frame with a waited-for id answers the wait; a frame of a stream
// in its place fails the wait instead of the daemon's write.
function settleAnswer(waiter: PromiseWithResolvers<PeerAnswer>, frame: PeerFrame): void {
  if (frame.kind !== 'response') {
    waiter.reject(new TypeError(`message ${frame.id} is an ${frame.kind}, not a response`));

    return;
  }

  waiter.resolve({ status: frame.status, headers: frame.headers, body: frame.body });
}
