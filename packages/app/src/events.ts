import { eventsSocketPath } from '@atc/config/config';

interface EventsIO {
  readonly socketPath: string;
  readonly writeOut: (buf: Uint8Array) => void;
  readonly printError: (line: string) => void;
  readonly exit: (code: number) => void;
}

const processIO: EventsIO = {
  socketPath: eventsSocketPath,
  writeOut: (buf) => {
    process.stdout.write(buf);
  },
  printError: (line) => {
    console.error(line);
  },
  exit: (code) => process.exit(code),
};

/**
 * Streams the daemon's events socket to stdout, one NDJSON wire event per
 * line, until the daemon closes the connection. When no daemon is
 * listening, prints a hint to stderr and exits nonzero instead of booting
 * one. A daemon that closes the connection before it sends a byte refused
 * the stream, so that close prints an error to stderr and exits nonzero
 * too, where a close after the stream started ends the command cleanly.
 */
export async function runEvents(io: EventsIO = processIO): Promise<void> {
  const closed = Promise.withResolvers<void>();
  let bytes = 0;

  try {
    await Bun.connect({
      unix: io.socketPath,
      socket: {
        data(_socket, buf) {
          bytes += buf.byteLength;

          io.writeOut(buf);
        },
        close() {
          closed.resolve();
        },
        error() {
          closed.resolve();
        },
      },
    });
  } catch (error) {
    // A close that lands while the connect completes fails the connect
    // itself with a reset: the daemon was there and closed the stream.
    if (error instanceof Error && 'code' in error && error.code === 'ECONNRESET') {
      closed.resolve();
    } else {
      io.printError(`atc events: no daemon at ${io.socketPath} — start atc first`);
      io.exit(1);

      return;
    }
  }

  await closed.promise;

  if (bytes === 0) {
    io.printError(
      `atc events: the daemon at ${io.socketPath} closed the stream before it sent an event`,
    );

    io.exit(1);
  }
}
