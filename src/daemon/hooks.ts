import { unlinkSync } from 'node:fs';
import { socketPath } from '../shared/config';
import { isRecord } from '../shared/report';
import type { SessionID } from '../shared/session-id';
import { toSessionID } from '../shared/to-session-id';

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

          try {
            const parsed: unknown = JSON.parse(line);

            if (
              isRecord(parsed) &&
              typeof parsed['atcId'] === 'string' &&
              typeof parsed['event'] === 'string' &&
              isRecord(parsed['payload'])
            ) {
              onEvent({
                atcId: toSessionID(parsed['atcId']),
                event: parsed['event'],
                payload: parsed['payload'],
              });
            }
          } catch {}
        }
      },
      open(socket) {
        socket.data = { pending: '', decoder: new TextDecoder() };
      },
      error() {},
    },
  });
}
