import { join } from 'node:path';
import type { ExecutionProvider, HarnessRelay } from '@atc/plugin-api';
import { createLineDecoder } from '@atc/protocol/wire';
import type { LineDecoder } from '@atc/protocol/wire';
import type { Socket, UnixSocketListener } from 'bun';
import { createStubExecutionProvider } from './create-stub-execution-provider';

interface StubRelayProviderConfig {
  readonly directory: string;
  readonly droppedConnections?: number;
}

interface StubRelayProvider extends ExecutionProvider {
  readonly buildGuestSocketPath: (session: string) => string;
  readonly countConnections: () => number;

  readonly stop: () => void;
}

interface GuestConnection {
  relay: HarnessRelay | null;
  readonly decoder: LineDecoder;
  unsent: Uint8Array;
  readonly lineListeners: ((line: string) => void)[];
  readonly endListeners: (() => void)[];
  readonly closeListeners: (() => void)[];
}

export function createStubRelayProvider(config: StubRelayProviderConfig): StubRelayProvider {
  const provider = createStubExecutionProvider({ kind: 'imp-like', remote: true });
  const listeners: UnixSocketListener<GuestConnection>[] = [];

  const encoder = new TextEncoder();

  let dropsLeft = config.droppedConnections ?? 0;
  let connections = 0;
  const buildGuestSocketPath = (session: string) => join(config.directory, `${session}.sock`);

  const buildRelay = (
    socket: Socket<GuestConnection>,
    connection: GuestConnection,
  ): HarnessRelay => ({
    onLine: (listener) => {
      connection.lineListeners.push(listener);
    },
    onEnd: (listener) => {
      connection.endListeners.push(listener);
    },
    onClose: (listener) => {
      connection.closeListeners.push(listener);
    },
    writeLine: (line) => {
      const bytes = encoder.encode(`${line}\n`);

      const joined = new Uint8Array(connection.unsent.length + bytes.length);

      joined.set(connection.unsent, 0);
      joined.set(bytes, connection.unsent.length);

      connection.unsent = joined.subarray(socket.write(joined));

      return Promise.resolve();
    },
    close: () => {
      socket.end();
    },
  });

  return {
    ...provider,
    spawnHarness: (spec) => {
      const onRelay = spec.onRelay;

      if (onRelay !== undefined) {
        listeners.push(
          Bun.listen<GuestConnection>({
            unix: buildGuestSocketPath(spec.session),
            socket: {
              open(socket) {
                connections += 1;

                socket.data = {
                  relay: null,
                  decoder: createLineDecoder(),
                  unsent: new Uint8Array(0),
                  lineListeners: [],
                  endListeners: [],
                  closeListeners: [],
                };

                if (dropsLeft > 0) {
                  dropsLeft -= 1;

                  return;
                }

                socket.data.relay = buildRelay(socket, socket.data);

                onRelay(socket.data.relay);
              },
              data(socket, chunk) {
                if (socket.data.relay === null) {
                  return;
                }

                for (const line of socket.data.decoder.splitChunk(chunk)) {
                  for (const listener of socket.data.lineListeners) {
                    listener(line);
                  }
                }
              },
              drain(socket) {
                socket.data.unsent = socket.data.unsent.subarray(socket.write(socket.data.unsent));
              },
              end(socket) {
                for (const listener of socket.data.endListeners) {
                  listener();
                }
              },
              close(socket) {
                for (const listener of socket.data.closeListeners) {
                  listener();
                }
              },
              error() {},
            },
          }),
        );
      }

      return provider.spawnHarness(spec);
    },
    buildGuestSocketPath,
    countConnections: () => connections,
    stop: () => {
      for (const listener of listeners) {
        listener.stop(true);
      }
    },
  };
}
