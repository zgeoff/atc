type ReportEnd = 'close' | 'wait';

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

async function sendLine(sock: string, line: string, end: ReportEnd): Promise<boolean> {
  const resolvers = Promise.withResolvers<boolean>();

  const bytes = new TextEncoder().encode(line);

  let written = 0;
  let isFailed = false;

  // Bun closes the whole socket at once when a socket ends, so to wait for the daemon's
  // close, only a half-close leaves the socket open.
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
