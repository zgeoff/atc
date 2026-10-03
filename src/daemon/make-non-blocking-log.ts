import { write } from 'node:fs';
import { promisify } from 'node:util';

// The most bytes of lines that wait behind the write in flight; a line past
// it is dropped and counted.
const MAX_QUEUED_BYTES = 64 * 1024;

// The node:fs write without a callback, which Bun runs on its thread pool.
const writeAsync = promisify(write);

/**
 * Makes a log that writes each line to a file descriptor without ever
 * blocking the event loop, so a reader that stops reading stalls nothing
 * but the log. Each write goes through the asynchronous node:fs write,
 * which Bun runs on its thread pool, one write at a time. Lines that
 * arrive meanwhile queue up to 64 KiB; a line past that is dropped, and the
 * next write after the drops starts with one `atc log dropped=N` line. A
 * failed write drops its lines and counts them the same way, and the next
 * line logged writes again.
 */
export function makeNonBlockingLog(fd: number): (line: string) => void {
  let queue: string[] = [];
  let queuedBytes = 0;
  let dropped = 0;
  let writing = false;

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
      dropped += lineCount;
      writing = false;

      return;
    }

    writeNext();
  };

  return (line) => {
    if (!recordLine(line)) {
      dropped++;
    }

    if (!writing) {
      writeNext();
    }
  };
}
