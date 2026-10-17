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

// Each write goes through the asynchronous node:fs write on Bun's thread pool, so a reader that
// stops reading stalls only the log. A dropped or failed line is counted, and the next write
// starts with `atc log dropped=N`. A write to a full pipe nobody reads never returns.
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
