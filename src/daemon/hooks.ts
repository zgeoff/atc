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

export function startHookServer(onEvent: (e: HookEvent) => void, path: string = socketPath) {
  try {
    unlinkSync(path);
  } catch {}

  return Bun.listen<string>({
    unix: path,
    socket: {
      data(socket, buf) {
        const buffered = (socket.data ?? '') + buf.toString();
        const lines = buffered.split('\n');

        socket.data = lines.pop() ?? '';

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
        socket.data = '';
      },
      error() {},
    },
  });
}
