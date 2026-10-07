import { OutboundQueue } from '../protocol/outbound-queue';
import { waitFor } from './wait-for';

interface LineSocket {
  // Every complete newline-terminated line the peer sent, in order.
  readonly lines: string[];

  // Resolves once the connection has closed, from either end.
  readonly closed: Promise<void>;

  readonly sendLine: (line: string) => void;
  readonly waitForLines: (count: number, timeoutMs?: number) => Promise<string[]>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Connects to a unix socket that speaks newline-delimited lines, such as
 * the daemon's, with no handshake. `sendLine` appends the newline and
 * sends the whole line however large, the rest going out as the socket
 * drains. Every complete line the peer sends lands in `lines`, a partial
 * line buffered across reads; `waitForLines` polls until `lines` holds at
 * least `count` and returns it, throwing once `timeoutMs` passes first.
 * Disposal ends the connection; hold the result with `await using`.
 */
export async function openLineSocket(path: string): Promise<LineSocket> {
  const lines: string[] = [];
  const closed = Promise.withResolvers<void>();
  let buffer = '';
  let queue: OutboundQueue | null = null;

  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_socket, buf) {
        buffer += buf.toString();

        const parts = buffer.split('\n');

        buffer = parts.pop() ?? '';

        lines.push(...parts.filter((part) => part.trim() !== ''));
      },
      drain() {
        queue?.drain();
      },
      close() {
        closed.resolve();
      },
      error() {},
    },
  });

  // Room for the largest line a test sends in one piece.
  queue = new OutboundQueue(socket, 8 * 1024 * 1024);

  const sending = queue;

  return {
    lines,
    closed: closed.promise,
    sendLine(line: string) {
      sending.send(`${line}\n`);
    },
    waitForLines(count: number, timeoutMs = 5000) {
      return waitFor(
        () => {
          if (lines.length < count) {
            throw new Error(`timed out waiting for ${count} lines; got ${JSON.stringify(lines)}`);
          }

          return lines;
        },
        { timeoutMs },
      );
    },
    [Symbol.asyncDispose]: () => {
      socket.end();

      return Promise.resolve();
    },
  };
}
