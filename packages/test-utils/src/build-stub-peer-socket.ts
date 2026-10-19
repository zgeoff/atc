export function buildStubPeerSocket() {
  const decoder = new TextDecoder();
  const waiters = new Map<string, PromiseWithResolvers<Record<string, unknown>>>();

  let accepting = true;
  let ended = false;
  let refusedWrites = 0;
  let written = '';

  const collectFrames = (): Record<string, unknown>[] =>
    written
      .split('\n')
      .slice(0, -1)
      .map((line): Record<string, unknown> => toFrame(JSON.parse(line)));

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
          const id = frame['i'];
          const waiter = typeof id === 'string' ? waiters.get(id) : undefined;

          if (typeof id === 'string' && waiter !== undefined) {
            waiters.delete(id);
            waiter.resolve(getPayload(frame));
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

    // The payload of the first message written under the peer message id.
    waitForAnswer: (id: string): Promise<Record<string, unknown>> => {
      const found = collectFrames().find((frame) => frame['i'] === id);

      if (found !== undefined) {
        return Promise.resolve(getPayload(found));
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

function getPayload(frame: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return toFrame(frame['p']);
}
