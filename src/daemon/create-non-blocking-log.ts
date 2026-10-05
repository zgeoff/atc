import { write } from 'node:fs';
import { promisify } from 'node:util';

// The most bytes of lines that wait behind the write in flight; a line past
// it is dropped and counted.
const MAX_QUEUED_BYTES = 64 * 1024;

// The node:fs write without a callback, which Bun runs on its thread pool.
const writeAsync = promisify(write);

/**
 * A log that never blocks the event loop. `log` queues one line, and
 * `drain` resolves once every queued line is written or the given number of
 * milliseconds has passed, whichever comes first.
 */
export interface NonBlockingLog {
  readonly log: (line: string) => void;
  readonly drain: (timeoutMs: number) => Promise<void>;
}

/**
 * Creates a log that writes each line to a file descriptor without ever
 * blocking the event loop, so a reader that stops reading stalls nothing
 * but the log. Each write goes through the asynchronous node:fs write,
 * which Bun runs on its thread pool, one write at a time. Lines that
 * arrive meanwhile queue up to 64 KiB; a line past that is dropped, and the
 * next write after the drops starts with one `atc log dropped=N` line. A
 * failed write drops its lines and counts them the same way, and the next
 * line logged writes again.
 *
 * A write to a full pipe that nobody reads never returns, and it keeps the
 * process alive until the process calls exit. A process that shuts down
 * drains the log with a timeout and then exits: every queued line reaches a
 * reader that keeps reading, and an unread pipe holds the exit back no
 * longer than the timeout.
 */
export function createNonBlockingLog(fd: number): NonBlockingLog {
  let queue: string[] = [];
  let queuedBytes = 0;
  let dropped = 0;
  let writing = false;

  // The drains that wait for the log to have nothing left to write.
  let idleWaiters: (() => void)[] = [];

  const recordLine = (line: string): boolean => {
    const text = `${line}\n`;
    const bytes = Buffer.byteLength(text);

    if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
      return false;
    }

    queue.push(text);

    queuedBytes += bytes;

    return true;
  };

  const writeNext = (): void => {
    if (queue.length === 0 && dropped === 0) {
      writing = false;

      releaseIdleWaiters();

      return;
    }

    writing = true;

    const lines = dropped > 0 ? [`atc log dropped=${String(dropped)}\n`, ...queue] : queue;

    // The lines this write stands for, the ones the dropped line counts
    // included, which a failed write drops again.
    const count = dropped + queue.length;

    queue = [];
    queuedBytes = 0;
    dropped = 0;
    void writeChunk(Buffer.from(lines.join('')), count);
  };

  const writeChunk = async (chunk: Buffer, lineCount: number): Promise<void> => {
    let rest = chunk;

    try {
      while (rest.length > 0) {
        const result = await writeAsync(fd, rest);

        rest = rest.subarray(result.bytesWritten);
      }
    } catch {
      // A drain stops waiting here too: the next write would most likely
      // fail the same way, and the lines it would carry stay counted.
      dropped += lineCount;
      writing = false;

      releaseIdleWaiters();

      return;
    }

    writeNext();
  };

  const releaseIdleWaiters = (): void => {
    const waiters = idleWaiters;

    idleWaiters = [];

    for (const resolve of waiters) {
      resolve();
    }
  };

  return {
    log: (line) => {
      if (!recordLine(line)) {
        dropped++;
      }

      if (!writing) {
        writeNext();
      }
    },
    drain: async (timeoutMs) => {
      // Lines left behind by a failed write wait for the next line logged,
      // so a drain writes them itself.
      if (!writing) {
        writeNext();
      }

      if (!writing) {
        return;
      }

      const idle = Promise.withResolvers<void>();

      idleWaiters.push(idle.resolve);

      const timer = setTimeout(idle.resolve, timeoutMs);

      await idle.promise;

      clearTimeout(timer);
    },
  };
}
