// How the reporter ends its side once the line is out: `close` closes the connection, and `wait`
// closes only its writing side and waits for the daemon to close the connection, so a report the
// daemon holds keeps its hook running.
type ReportEnd = 'close' | 'wait';

// Whether the socket took the whole line and closed cleanly in time; a line
// that did not is lost.
export async function sendReport(
  sock: string,
  line: string,
  timeoutMs: number,
  end: ReportEnd = 'close',
): Promise<boolean> {
  try {
    return await Promise.race([sendLine(sock, line, end), Bun.sleep(timeoutMs).then(() => false)]);
  } catch {
    return false;
  }
}

interface EndableSocket {
  readonly end: () => void;
  readonly shutdown: () => void;
}

// Fire-and-forget delivery of one JSON line to the atc unix socket, used by
// the hook and statusline commands running inside wrangled sessions. Never
// throws: a dead socket must not break the session doing the reporting.
async function sendLine(sock: string, line: string, end: ReportEnd): Promise<boolean> {
  const resolvers = Promise.withResolvers<boolean>();

  const bytes = new TextEncoder().encode(line);

  let written = 0;
  let isFailed = false;

  // Bun's end() closes the whole socket at once, and only shutdown() leaves it open to the
  // daemon's close.
  const finish = (socket: EndableSocket) => {
    if (end === 'wait') {
      socket.shutdown();
    } else {
      socket.end();
    }
  };

  await Bun.connect({
    unix: sock,
    socket: {
      // A write returns the bytes the socket accepted and drops the rest, so
      // a line larger than the socket buffer goes out across drain calls.
      open(socket) {
        written += socket.write(bytes.subarray(written));

        if (written >= bytes.length) {
          finish(socket);
        }
      },
      drain(socket) {
        written += socket.write(bytes.subarray(written));

        if (written >= bytes.length) {
          finish(socket);
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
