import { DaemonError } from '@atc/protocol/wire';

// The status a live-terminal request answers with when its first snapshot
// fails. A session the caller cannot see answers 404, as one that does not
// exist does.
export function pickSnapshotStatus(error: unknown): 404 | 409 | 503 {
  if (error instanceof DaemonError && error.code === 'no_such_session') {
    return 404;
  }

  if (error instanceof DaemonError && error.code === 'session_dead') {
    return 409;
  }

  return 503;
}
