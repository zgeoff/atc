import type { DaemonRecord } from './read-daemon-record';

export interface StaleDaemonEvidence {
  // The socket whose daemon refused the handshake.
  readonly socketPath: string;
  readonly record: DaemonRecord | null;

  // The socket the pid file sits beside, and the pid it holds.
  readonly pidFileSocketPath: string;
  readonly pidFilePID: number | null;
}

// a record for any other socket belongs to a different daemon, so it never
// supplies the pid.
export function pickStaleDaemonPID(evidence: StaleDaemonEvidence): number | null {
  if (evidence.record !== null && evidence.record.socketPath === evidence.socketPath) {
    return evidence.record.pid;
  }

  if (evidence.socketPath === evidence.pidFileSocketPath) {
    return evidence.pidFilePID;
  }

  return null;
}
