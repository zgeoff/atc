import { eventsSocketPath } from './shared/config';

/**
 * Streams the daemon's events socket to stdout, one NDJSON wire event per
 * line, until the daemon closes the connection. When no daemon is
 * listening, prints a hint to stderr and exits nonzero instead of booting
 * one.
 */
export async function runEvents(): Promise<void> {
  const closed = Promise.withResolvers<void>();

  try {
    await Bun.connect({
      unix: eventsSocketPath,
      socket: {
        data(_socket, buf) {
          process.stdout.write(buf);
        },
        close() {
          closed.resolve();
        },
        error() {
          closed.resolve();
        },
      },
    });
  } catch {
    console.error(`atc events: no daemon at ${eventsSocketPath} — start atc first`);
    process.exit(1);
  }

  await closed.promise;
}
