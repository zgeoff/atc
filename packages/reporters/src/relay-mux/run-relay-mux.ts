import type { RelayMux } from './start-relay-mux';
import { startRelayMux } from './start-relay-mux';

// Runs the guest's end of a relay: the bridge socket at the given path, and frames over this
// process's stdin and stdout. It returns once the socket is bound, and the process then lives
// until the provider or the host ends it, whether or not stdin closes.
export async function runRelayMux(socketPath: string): Promise<void> {
  process.stdout.on('error', () => {});

  const mux = await startRelayMux({
    socketPath,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
  });

  process.stdin.on('data', (data: Uint8Array) => {
    mux.feed(data);
  });

  process.stdin.on('error', () => {});

  // a closed stdin leaves the listening socket, which keeps the process alive
  process.stdin.resume();

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      void stopAndExit(mux);
    });
  }
}

async function stopAndExit(mux: RelayMux): Promise<void> {
  await mux.stop();

  process.exit(0);
}
