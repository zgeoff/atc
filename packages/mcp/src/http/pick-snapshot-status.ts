import { DaemonError } from '@atc/protocol/wire';

export function pickSnapshotStatus(error: unknown): 404 | 409 | 503 {
  if (error instanceof DaemonError && error.code === 'no_such_session') {
    return 404;
  }

  if (error instanceof DaemonError && error.code === 'session_dead') {
    return 409;
  }

  return 503;
}
