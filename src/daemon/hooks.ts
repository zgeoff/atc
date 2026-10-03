import { unlinkSync } from 'node:fs';
import type { HookEvent } from '../protocol/hook-event';
import { LineDecoder } from '../protocol/line-decoder';
import { socketPath } from '../shared/config';
import { parseHookLine } from './parse-hook-line';

// Per-connection read state: the connection's own line framing.
interface HookConnection {
  readonly lines: LineDecoder;
}

export function startHookServer(onEvent: (e: HookEvent) => void, path: string = socketPath) {
  try {
    unlinkSync(path);
  } catch {}

  return Bun.listen<HookConnection>({
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
  });
}
