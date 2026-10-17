// Fire-and-forget delivery of one JSON line to the atc unix socket, used by
// the hook and statusline commands running inside wrangled sessions. Never
// throws: a dead socket must not break the session doing the reporting.
async function sendLine(sock: string, line: string): Promise<boolean> {
  const resolvers = Promise.withResolvers<boolean>();

  const bytes = new TextEncoder().encode(line);

  let written = 0;
  let isFailed = false;

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
        resolvers.resolve(!isFailed && written >= bytes.length);
      },
      data() {},
      error() {
        isFailed = true;
      },
    },
  });

  return resolvers.promise;
}

// Whether the socket took the whole line and closed cleanly in time; a line
// that did not is lost.
export async function sendReport(sock: string, line: string, timeoutMs: number): Promise<boolean> {
  try {
    return await Promise.race([sendLine(sock, line), Bun.sleep(timeoutMs).then(() => false)]);
  } catch {
    return false;
  }
}
