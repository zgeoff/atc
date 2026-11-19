import type { DaemonRecord } from '../daemon-files/read-daemon-record';

export interface StaleDaemonEvidence {
  readonly socketPath: string;
  readonly record: DaemonRecord | null;

  readonly pidFileSocketPath: string;
  readonly pidFilePID: number | null;
}

export function pickStaleDaemonPID(evidence: StaleDaemonEvidence): number | null {
  if (evidence.record !== null && evidence.record.socketPath === evidence.socketPath) {
    return evidence.record.pid;
  }

  if (evidence.socketPath === evidence.pidFileSocketPath) {
    return evidence.pidFilePID;
  }

  return null;
}
