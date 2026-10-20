import { unlinkSync } from 'node:fs';
import { socketPath } from '@atc/config';
import type { HookEvent } from '@atc/protocol/session';
import { LineDecoder } from '@atc/protocol/wire';
import { parseHookLine } from '../transport/parse-hook-line';
import { withOwnerOnlySocket } from '../transport/with-owner-only-socket';

// Per-connection read state: the connection's own line framing.
interface HookConnection {
  readonly lines: LineDecoder;
}

export function startHookServer(
  onEvent: (hookEvent: HookEvent) => void,
  path: string = socketPath,
) {
  try {
    unlinkSync(path);
  } catch {}

  return withOwnerOnlySocket(path, () =>
    Bun.listen<HookConnection>({
      unix: path,
      socket: {
        data(socket, buf) {
          for (const line of socket.data.lines.splitChunk(buf)) {
            const event = parseHookLine(line);

            if (event !== null) {
              onEvent(event);
            }
          }
        },
        open(socket) {
          socket.data = { lines: new LineDecoder() };
        },
        error() {},
      },
    }),
  );
}
