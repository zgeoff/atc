// The slice of a Bun socket the queue needs; `write` returns bytes accepted.
export interface SocketWriter {
  readonly write: (data: Uint8Array) => number;
}

export interface OutboundQueue {
  readonly queuedBytes: number;

  // false: the payload was refused whole because the queue is over capacity.
  readonly send: (payload: string) => boolean;
  readonly drain: () => void;
}

const encoder = new TextEncoder();

// The bytes a queue holds when its owner gives no capacity.
export const DEFAULT_QUEUE_BYTES = 2 * 1024 * 1024;

// `socket.write()` drops whatever it does not accept, so a short write parks
// the rest here; a payload once started is never cut, even past capacity
export function createOutboundQueue(
  socket: SocketWriter,
  capacity = DEFAULT_QUEUE_BYTES,
): OutboundQueue {
  const chunks: Uint8Array[] = [];
  let queued = 0;

  return {
    get queuedBytes() {
      return queued;
    },

    send: (payload) => {
      const bytes = encoder.encode(payload);

      if (chunks.length > 0) {
        if (queued + bytes.length > capacity) {
          return false;
        }

        chunks.push(bytes);

        queued += bytes.length;

        return true;
      }

      const wrote = Math.max(socket.write(bytes), 0);

      if (wrote < bytes.length) {
        const rest = bytes.subarray(wrote);

        chunks.push(rest);

        queued += rest.length;
      }

      return true;
    },

    drain: () => {
      while (chunks.length > 0) {
        const [head] = chunks;

        if (head === undefined) {
          return;
        }

        const wrote = Math.max(socket.write(head), 0);

        queued -= wrote;

        if (wrote < head.length) {
          chunks[0] = head.subarray(wrote);

          return;
        }

        chunks.shift();
      }
    },
  };
}
