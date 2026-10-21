import { createLineDecoder } from '../wire/create-line-decoder';

export interface BridgeSocket {
  readonly writeLine: (value: Readonly<Record<string, unknown>>) => void;
  readonly end: () => void;

  // Settles once the connection has closed, from either side.
  readonly closed: Promise<void>;
}

export async function openBridgeSocket(
  path: string,
  onLine: (line: Readonly<Record<string, unknown>>) => void,
): Promise<BridgeSocket> {
  const encoder = new TextEncoder();

  const decoder = createLineDecoder();
  const closed = Promise.withResolvers<void>();

  let unsent = new Uint8Array(0);

  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_socket, buf) {
        for (const line of decoder.splitChunk(buf)) {
          const parsed = parseLine(line);

          if (parsed !== null) {
            onLine(parsed);
          }
        }
      },
      drain(bridgeSocket) {
        unsent = unsent.subarray(bridgeSocket.write(unsent));
      },
      close() {
        closed.resolve();
      },
      error() {
        closed.resolve();
      },
    },
  });

  return {
    writeLine: (value) => {
      const bytes = encoder.encode(`${JSON.stringify(value)}\n`);

      const joined = new Uint8Array(unsent.length + bytes.length);

      joined.set(unsent, 0);
      joined.set(bytes, unsent.length);

      unsent = joined.subarray(socket.write(joined));
    },
    end: () => {
      socket.end();
    },
    closed: closed.promise,
  };
}

function parseLine(line: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(line);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null;
  } catch {
    return null;
  }
}
