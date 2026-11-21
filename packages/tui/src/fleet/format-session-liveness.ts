import type { DaemonName } from './session-key';
import type { MirrorSession } from './to-mirror-session';

// One daemon's listed sessions and whether each is live, as text that changes exactly when a
// session is added, removed, or gains or loses its terminal.
export function formatSessionLiveness(
  sessions: readonly Pick<MirrorSession, 'daemon' | 'id' | 'alive'>[],
  daemon: DaemonName,
): string {
  return sessions
    .filter((session) => session.daemon === daemon)
    .map((session) => `${session.id}:${session.alive ? 'live' : 'dead'}`)
    .join(',');
}
