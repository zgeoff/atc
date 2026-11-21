import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createOutboundQueue } from '../wire/index';
import type { OutboundQueue } from '../wire/index';

interface SocketLines {
  readonly lines: string[];

  readonly closed: Promise<void>;

  readonly write: (data: string) => void;
  readonly waitForLine: (count?: number, timeoutMs?: number) => Promise<string[]>;
  readonly unsubscribe: () => void;
}

interface SocketLinesOptions {
  readonly queueBytes?: number;

  readonly now?: () => number;

  readonly wait?: (delayMs: number) => Promise<void>;
}

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

  const unsubscribe = registerTestCleanup(() => {
    socket.end();
  });

  queue = createOutboundQueue(socket, options.queueBytes ?? 8 * 1024 * 1024);

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
      await waitFor(
        () => {
          if (!isClosed) {
            requireLines(count);
          }
        },
        {
          timeoutMs,
          now: options.now ?? Date.now,
          sleep: options.wait ?? Bun.sleep,
        },
      );

      return requireLines(count);
    },
    unsubscribe,
  };
}
