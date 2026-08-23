// Fire-and-forget delivery of one JSON line to the atc unix socket, used by
// the hook and statusline commands running inside wrangled sessions. Never
// throws: a dead socket must not break the session doing the reporting.
async function sendLine(sock: string, line: string): Promise<void> {
  const resolvers = Promise.withResolvers<void>();

  await Bun.connect({
    unix: sock,
    socket: {
      open(s) {
        s.write(line);
        s.end();
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
