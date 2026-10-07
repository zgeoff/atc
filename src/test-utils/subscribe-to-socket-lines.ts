import { OutboundQueue } from '../protocol/outbound-queue';
import { waitFor } from './wait-for';

interface SocketLines {
  // Every complete newline-terminated line the peer sent, in order.
  readonly lines: string[];

  // Resolves once the connection has closed, from either end.
  readonly closed: Promise<void>;

  readonly write: (data: string) => void;
  readonly waitForLine: (count?: number, timeoutMs?: number) => Promise<string[]>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

interface SocketLinesOptions {
  // How many unsent bytes the connection holds before it refuses a write.
  readonly queueBytes?: number;
}

/**
 * Connects to a unix socket and collects every complete newline-terminated
 * line it sends, buffering a partial line across reads. `write` sends the
 * whole of what it is given, the rest going out as the socket drains,
 * and throws instead when the unsent bytes already fill the queue. `waitForLine` polls until the collected count reaches
 * `count` and returns the lines, throwing when `timeoutMs` passes first or
 * the connection closes short of the count. Disposal ends the connection.
 */
export async function subscribeToSocketLines(
  path: string,
  options: SocketLinesOptions = {},
): Promise<SocketLines> {
  const lines: string[] = [];
  const closed = Promise.withResolvers<void>();
  let isClosed = false;
  let buffer = '';
  let queue: OutboundQueue | null = null;

  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_s, buf) {
        buffer += buf.toString();

        const parts = buffer.split('\n');

        buffer = parts.pop() ?? '';

        lines.push(...parts.filter((part) => part.trim() !== ''));
      },
      drain() {
        queue?.drain();
      },
      close() {
        isClosed = true;

        closed.resolve();
      },
      error() {},
    },
  });

  // The default leaves room for the largest payload a test sends in one
  // piece.
  queue = new OutboundQueue(socket, options.queueBytes ?? 8 * 1024 * 1024);

  const sending = queue;

  const requireLines = (count: number) => {
    if (lines.length < count) {
      throw new Error(`timed out waiting for ${count} lines; got ${JSON.stringify(lines)}`);
    }

    return lines;
  };

  return {
    lines,
    closed: closed.promise,
    write(data: string) {
      if (!sending.send(data)) {
        throw new Error(
          `the socket refused a ${data.length}-character write: ${sending.queuedBytes} bytes are still unsent`,
        );
      }
    },
    async waitForLine(count = 1, timeoutMs = 5000) {
      // The poll ends early once the connection closes, since no more lines
      // can arrive.
      await waitFor(
        () => {
          if (!isClosed) {
            requireLines(count);
          }
        },
        { timeoutMs },
      );

      return requireLines(count);
    },
    [Symbol.asyncDispose]: () => {
      socket.end();

      return Promise.resolve();
    },
  };
}
