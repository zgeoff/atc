// Fire-and-forget delivery of one JSON line to the atc unix socket, used by
// the hook and statusline commands running inside wrangled sessions. Never
// throws: a dead socket must not break the session doing the reporting.
async function sendLine(sock: string, line: string): Promise<void> {
  const resolvers = Promise.withResolvers<void>();

  const bytes = new TextEncoder().encode(line);

  let written = 0;

  await Bun.connect({
    unix: sock,
    socket: {
      // A write returns the bytes the socket accepted and drops the rest, so
      // a line larger than the socket buffer goes out across drain calls.
      open(s) {
        written += s.write(bytes.subarray(written));

        if (written >= bytes.length) {
          s.end();
        }
      },
      drain(s) {
        written += s.write(bytes.subarray(written));

        if (written >= bytes.length) {
          s.end();
        }
      },
      close() {
        resolvers.resolve();
      },
      data() {},
      error() {},
    },
  });

  await resolvers.promise;
}

export async function sendReport(sock: string, line: string, timeoutMs: number): Promise<void> {
  try {
    await Promise.race([sendLine(sock, line), Bun.sleep(timeoutMs)]);
  } catch {}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
