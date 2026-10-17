import { write } from 'node:fs';
import { promisify } from 'node:util';
import { getStreamSink } from '@logtape/logtape';
import type { Drainable, Sink } from '@logtape/logtape';
import { formatLogLine } from './format-log-line';

// How many lines the sink holds before it starts to write them, and how
// often it writes the lines it holds. Behind the lines it is writing, it
// holds twice the batch at most, and past that it drops the oldest line.
const BATCH_LINES = 512;
const FLUSH_INTERVAL_MS = 100;

// The node:fs write without a callback, which Bun runs on its thread pool.
const writeAsync = promisify(write);

/**
 * Creates a LogTape sink that writes each record as one plain line to a
 * file descriptor without ever blocking the event loop, so a reader that
 * stops reading stalls nothing but the log. LogTape's non-blocking stream
 * sink holds the records, and each write goes through the asynchronous
 * node:fs write, which Bun runs on its thread pool, one write at a time.
 *
 * A record the sink drops, or one that fails to format or to write, is
 * counted, and the next write starts with one `atc log dropped=N` line. A
 * failed write counts the lines it carried again, and the next write
 * tries again. Disposal writes the lines the sink still holds, then the
 * count of any it dropped, and leaves the descriptor open.
 *
 * A write to a full pipe that nobody reads never returns, and it keeps the
 * process alive until the process calls exit, which nothing here holds
 * back.
 */
export function createStderrSink(fd: number): Sink & AsyncDisposable & Drainable {
  const encoder = new TextEncoder();

  let dropped = 0;

  const writeLines = async (chunk: Uint8Array): Promise<void> => {
    const count = dropped;

    dropped = 0;

    let rest =
      count > 0
        ? Buffer.concat([encoder.encode(`atc log dropped=${String(count)}\n`), chunk])
        : chunk;

    try {
      while (rest.length > 0) {
        const result = await writeAsync(fd, rest);

        rest = rest.subarray(result.bytesWritten);
      }
    } catch {
      dropped += count + (chunk.length > 0 ? 1 : 0);
    }
  };

  // A write never rejects, since a rejected write would end the stream for
  // good, and closing writes only the count of the dropped lines.
  const stream = new WritableStream<Uint8Array>({
    write: writeLines,
    close: () => writeLines(new Uint8Array()),
  });

  return getStreamSink(stream, {
    formatter: formatLogLine,
    encoder,
    nonBlocking: {
      bufferSize: BATCH_LINES,
      flushInterval: FLUSH_INTERVAL_MS,
      onDrop: (event) => {
        dropped += event.count;
      },
      onError: () => {
        dropped++;
      },
    },
  });
}
