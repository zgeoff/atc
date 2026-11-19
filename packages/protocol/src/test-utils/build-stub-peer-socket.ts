import { parsePeerFrame } from './parse-peer-frame';
import type { PeerFrame } from './parse-peer-frame';

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
        if (!accepting) {
          refusedWrites += 1;

          return 0;
        }

        written += decoder.decode(data, { stream: true });

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

function settleAnswer(waiter: PromiseWithResolvers<PeerAnswer>, frame: PeerFrame): void {
  if (frame.kind !== 'response') {
    waiter.reject(new TypeError(`message ${frame.id} is an ${frame.kind}, not a response`));

    return;
  }

  waiter.resolve({ status: frame.status, headers: frame.headers, body: frame.body });
}
