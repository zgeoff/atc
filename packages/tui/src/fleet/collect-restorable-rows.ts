import type { DaemonName } from './session-key';
import type { MirrorSession } from './to-mirror-session';
import type { FleetRow } from './types';

// The rows that fleet.restore on the primary daemon would bring back: an exited row whose session
// is no longer listed, and any other row whose session is not listed live.
export function collectRestorableRows(
  fleet: readonly FleetRow[],
  sessions: readonly Pick<MirrorSession, 'daemon' | 'id' | 'alive'>[],
  primary: DaemonName,
): FleetRow[] {
  const listed = sessions.filter((session) => session.daemon === primary);

  return fleet.filter((row) =>
    row.exited
      ? !listed.some((session) => session.id === row.sessionID)
      : !listed.some((session) => session.id === row.sessionID && session.alive),
  );
}
