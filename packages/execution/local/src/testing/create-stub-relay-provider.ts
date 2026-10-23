import { join } from 'node:path';
import type { ExecutionProvider, HarnessRelay, HarnessSpec } from '@atc/plugin-api';
import { buildSessionEnv } from '@atc/protocol/session';
import { createLineDecoder } from '@atc/protocol/wire';
import type { LineDecoder } from '@atc/protocol/wire';
import type { Socket, UnixSocketListener } from 'bun';
import { createStubExecutionProvider } from './create-stub-execution-provider';

interface StubRelayProviderConfig {
  readonly directory: string;
  readonly droppedTapOpens?: number;
}

interface StubRelayProvider extends ExecutionProvider {
  readonly buildGuestSocketPath: (session: string) => string;
  readonly countDroppedTapOpens: () => number;
  readonly stop: () => void;
}

interface GuestConnection {
  readonly decoder: LineDecoder;
  phase: 'first-line' | 'relayed' | 'dropped';
  unsent: Uint8Array;
  readonly lineListeners: ((line: string) => void)[];
  readonly endListeners: (() => void)[];
  readonly closeListeners: (() => void)[];
}

export function createStubRelayProvider(config: StubRelayProviderConfig): StubRelayProvider {
  const provider = createStubExecutionProvider({ kind: 'imp-like', remote: true });
  const listeners: UnixSocketListener<GuestConnection>[] = [];

  const encoder = new TextEncoder();

  let dropsLeft = config.droppedTapOpens ?? 0;
  let dropped = 0;
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

  // A host's relay can take a tap's connection and never pass it on, so the
  // stand-in drops a connection only on a first line that opens a tap.
  const startGuestListener = (spec: HarnessSpec, onRelay: (relay: HarnessRelay) => void) =>
    Bun.listen<GuestConnection>({
      unix: buildGuestSocketPath(spec.session),
      socket: {
        open(socket) {
          socket.data = {
            decoder: createLineDecoder(),
            phase: 'first-line',
            unsent: new Uint8Array(0),
            lineListeners: [],
            endListeners: [],
            closeListeners: [],
          };
        },
        data(socket, chunk) {
          const connection = socket.data;

          for (const line of connection.decoder.splitChunk(chunk)) {
            if (connection.phase === 'first-line') {
              if (dropsLeft > 0 && line.includes('"op":"tap.open"')) {
                dropsLeft -= 1;
                dropped += 1;
                connection.phase = 'dropped';
              } else {
                connection.phase = 'relayed';

                onRelay(buildRelay(socket, connection));
              }
            }

            if (connection.phase === 'relayed') {
              for (const listener of connection.lineListeners) {
                listener(line);
              }
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
    });

  return {
    ...provider,
    spawnHarness: (spec) => {
      const onRelay = spec.onRelay;

      if (onRelay === undefined) {
        return provider.spawnHarness(spec);
      }

      listeners.push(startGuestListener(spec, onRelay));

      return provider.spawnHarness({
        ...spec,
        env: {
          ...spec.env,
          ...buildSessionEnv({
            socket: buildGuestSocketPath(spec.session),
            bridge: true,
            outbox: join(config.directory, `${spec.session}.outbox`),
          }),
        },
      });
    },
    buildGuestSocketPath,
    countDroppedTapOpens: () => dropped,
    stop: () => {
      for (const listener of listeners) {
        listener.stop(true);
      }
    },
  };
}
