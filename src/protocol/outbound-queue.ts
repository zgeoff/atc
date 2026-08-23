// The slice of a Bun socket the queue needs; `write` returns bytes accepted.
export interface SocketWriter {
  // oxlint-disable-next-line prefer-readonly-parameter-types -- a readonly view cannot satisfy Bun's BufferSource union; the queue never mutates chunks
  readonly write: (data: Uint8Array) => number;
}

const encoder = new TextEncoder();

/**
 * Bounded outbound buffer for one socket. `socket.write()` returns bytes
 * accepted and silently drops the rest, so every short write parks the
 * remainder here and the socket's drain callback flushes it. A payload is
 * never cut mid-line: once its first byte is on the wire, the rest is
 * queued even past capacity, and only whole not-yet-started payloads are
 * refused on overflow.
 */
export class OutboundQueue {
  private readonly socket: SocketWriter;

  private readonly capacity: number;

  private chunks: Uint8Array[] = [];

  private queued = 0;

  constructor(socket: SocketWriter, capacity = 2 * 1024 * 1024) {
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
