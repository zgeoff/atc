import { buildShortName } from './build-short-name';

// The session ID is shortened so the reporter socket's path inside the guest stays within
// the length limit for a unix socket path.
export function buildReporterSocketBase(guestDir: string, sessionID: string): string {
  return `${guestDir}/run/${buildShortName(sessionID, 16)}`;
}
