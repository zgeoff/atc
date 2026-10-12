/**
 * A peer socket for tests that drive a daemon connection without a socket:
 * while accepting, it takes every byte at once, as a peer with room does,
 * and keeps what the daemon wrote; while not, it takes none and returns 0,
 * as a socket whose kernel buffer is full does, so backpressure is a switch
 * instead of a buffer race. It starts accepting, and `setAccepting` flips
 * it. `hasEnded` is true once the daemon has ended the connection, which
 * changes nothing else the stub does. `collectFrames`
 * parses each complete line written so far as one protocol frame, in order.
 * `waitForAnswer` resolves with the frame answering the request id once the
 * daemon has written it, that id left out, so two answers compare whole.
 */
export function buildStubPeerSocket() {
  const decoder = new TextDecoder();
  const waiters = new Map<number, PromiseWithResolvers<Record<string, unknown>>>();

  let accepting = true;
  let ended = false;
  let written = '';

  const collectFrames = (): Record<string, unknown>[] =>
    written
      .split('\n')
      .slice(0, -1)
      .map((line): Record<string, unknown> => toFrame(JSON.parse(line)));

  return {
    socket: {
      // oxlint-disable-next-line prefer-readonly-parameter-types -- a readonly view cannot satisfy the writer contract; the stub never mutates chunks
      write: (data: Uint8Array): number => {
        if (!accepting) {
          return 0;
        }

        written += decoder.decode(data, { stream: true });

        // Frames are parsed only for a pending wait, so a stray line fails
        // the read that looks at it rather than the daemon's write.
        for (const frame of waiters.size === 0 ? [] : collectFrames()) {
          const id = frame['id'];
          const waiter = typeof id === 'number' ? waiters.get(id) : undefined;

          if (waiter !== undefined) {
            waiters.delete(Number(id));
            waiter.resolve(buildAnswer(frame));
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
    collectFrames,
    waitForAnswer: (id: number): Promise<Record<string, unknown>> => {
      const found = collectFrames().find((frame) => frame['id'] === id);

      if (found !== undefined) {
        return Promise.resolve(buildAnswer(found));
      }

      const waiter = Promise.withResolvers<Record<string, unknown>>();

      waiters.set(id, waiter);

      return waiter.promise;
    },
  };
}

function toFrame(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`a protocol frame is a JSON object, not ${JSON.stringify(value)}`);
  }

  return Object.fromEntries(Object.entries(value));
}

function buildAnswer(frame: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frame).filter(([key]) => key !== 'id'));
}
