// Capped at 100 open connections so the flood stays under the host's open-file limit.
const BATCH = 100;

export async function sendLinesBeforeHandshake(port: number, count: number): Promise<void> {
  for (let start = 0; start < count; start += BATCH) {
    await Promise.all(
      Array.from({ length: Math.min(BATCH, count - start) }, async () => {
        const closed = Promise.withResolvers<void>();

        await Bun.connect({
          hostname: '127.0.0.1',
          port,
          socket: {
            open(socket) {
              socket.write('not a handshake\n');
            },
            data() {},
            close() {
              closed.resolve();
            },
          },
        });

        await closed.promise;
      }),
    );
  }
}
