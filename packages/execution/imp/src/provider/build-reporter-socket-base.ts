import { buildShortName } from './build-short-name';

// The path inside the guest a session's reporter socket and outbox share,
// short enough that the socket's path stays inside a unix socket's limit.
export function buildReporterSocketBase(guestDir: string, sessionID: string): string {
  return `${guestDir}/run/${buildShortName(sessionID, 16)}`;
}
