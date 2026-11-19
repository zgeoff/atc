import { write } from 'node:fs';
import { promisify } from 'node:util';
import { getStreamSink } from '@logtape/logtape';
import type { Drainable, Sink } from '@logtape/logtape';
import { formatLogLine } from './format-log-line';

const BATCH_LINES = 512;
const FLUSH_INTERVAL_MS = 100;
const writeAsync = promisify(write);

// The write runs on Bun's thread pool, so a reader that stops reading stalls only the log.
// A write to a full pipe that nobody reads never returns.
export function createStderrSink(
  fd: number,
  batchLines: number = BATCH_LINES,
): Sink & AsyncDisposable & Drainable {
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

  // A rejected write would put the stream in an error state for good, so every failure is caught.
  const stream = new WritableStream<Uint8Array>({
    write: writeLines,
    close: () => writeLines(new Uint8Array()),
  });

  return getStreamSink(stream, {
    formatter: formatLogLine,
    encoder,
    nonBlocking: {
      bufferSize: batchLines,
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
