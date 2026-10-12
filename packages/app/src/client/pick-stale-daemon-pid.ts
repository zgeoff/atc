import type { DaemonRecord } from '../shared/find-daemon-record';

export interface StaleDaemonEvidence {
  // The socket whose daemon refused the handshake.
  readonly socketPath: string;
  readonly record: DaemonRecord | null;

  // The socket the pid file sits beside, and the pid it holds.
  readonly pidFileSocketPath: string;
  readonly pidFilePID: number | null;
}

/**
 * Picks the pid of the daemon behind the socket that refused the
 * handshake, from whichever source belongs to that socket: the state
 * directory's record when it lists that socket, else the pid file beside
 * it. A record for any other socket belongs to a different daemon, so it
 * never supplies the pid; with no source for that socket, there is no pid
 * to stop.
 */
export function pickStaleDaemonPID(evidence: StaleDaemonEvidence): number | null {
  if (evidence.record !== null && evidence.record.socketPath === evidence.socketPath) {
    return evidence.record.pid;
  }

  if (evidence.socketPath === evidence.pidFileSocketPath) {
    return evidence.pidFilePID;
  }

  return null;
}
