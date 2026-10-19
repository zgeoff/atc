// The slice of a Bun socket the queue needs; `write` returns bytes accepted.
export interface SocketWriter {
  readonly write: (data: Uint8Array) => number;
}

const encoder = new TextEncoder();

// The bytes a queue holds when its owner gives no capacity.
export const DEFAULT_QUEUE_BYTES = 2 * 1024 * 1024;

// `socket.write()` drops whatever it does not accept, so a short write parks
// the rest here; a payload once started is never cut, even past capacity
export class OutboundQueue {
  private readonly socket: SocketWriter;

  private readonly capacity: number;

  private chunks: Uint8Array[] = [];

  private queued = 0;

  constructor(socket: SocketWriter, capacity = DEFAULT_QUEUE_BYTES) {
    this.socket = socket;
    this.capacity = capacity;
  }

  get queuedBytes(): number {
    return this.queued;
  }

  // false: the payload was refused whole because the queue is over capacity.
  send(payload: string): boolean {
    const bytes = encoder.encode(payload);

    if (this.chunks.length > 0) {
      if (this.queued + bytes.length > this.capacity) {
        return false;
      }

      this.chunks.push(bytes);

      this.queued += bytes.length;

      return true;
    }

    const wrote = Math.max(this.socket.write(bytes), 0);

    if (wrote < bytes.length) {
      const rest = bytes.subarray(wrote);

      this.chunks.push(rest);

      this.queued += rest.length;
    }

    return true;
  }

  drain(): void {
    while (this.chunks.length > 0) {
      const [head] = this.chunks;

      if (head === undefined) {
        return;
      }

      const wrote = Math.max(this.socket.write(head), 0);

      this.queued -= wrote;

      if (wrote < head.length) {
        this.chunks[0] = head.subarray(wrote);

        return;
      }

      this.chunks.shift();
    }
  }
}
