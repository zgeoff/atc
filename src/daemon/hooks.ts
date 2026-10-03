import { unlinkSync } from 'node:fs';
import { socketPath } from '../shared/config';
import type { SessionID } from '../shared/session-id';
import { parseHookLine } from './parse-hook-line';

export interface HookEvent {
  atcId: SessionID;
  event: string;
  payload: Record<string, unknown>;
}

// Per-connection read state: the unterminated tail of the line in progress,
// and a streaming decoder so a multi-byte character split across two reads
// decodes whole.
interface HookConnection {
  pending: string;
  readonly decoder: TextDecoder;
}

export function startHookServer(onEvent: (e: HookEvent) => void, path: string = socketPath) {
  try {
    unlinkSync(path);
  } catch {}

  return Bun.listen<HookConnection>({
    unix: path,
    socket: {
      data(socket, buf) {
        const conn = socket.data;
        const buffered = conn.pending + conn.decoder.decode(buf, { stream: true });
        const lines = buffered.split('\n');

        conn.pending = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim() === '') {
            continue;
          }

          const event = parseHookLine(line);

          if (event !== null) {
            onEvent(event);
          }
        }
      },
      open(socket) {
        socket.data = { pending: '', decoder: new TextDecoder() };
      },
      error() {},
    },
  });
}
