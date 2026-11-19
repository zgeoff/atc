import type { SessionID } from '@atcx/contract';
import type { Session } from '../sessions/session';
import type { PeerSession } from './create-daemon-connection';
import { readPeerPID } from './read-peer-pid';
import { readPeerSession } from './read-peer-session';

export function readSocketSession(
  socket: object,
  sessions: readonly Session[],
): PeerSession | null {
  const pid = readPeerPID(socket);

  if (pid === null) {
    return null;
  }

  const harnesses = new Map<number, SessionID>();

  for (const session of sessions) {
    if (session.pty?.pid !== undefined) {
      harnesses.set(session.pty.pid, session.id);
    }
  }

  const id = readPeerSession(pid, harnesses);

  return id === null ? null : { id };
}
