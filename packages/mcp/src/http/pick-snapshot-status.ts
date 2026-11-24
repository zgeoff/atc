import { findCodedError } from '../errors/find-coded-error';

export function pickSnapshotStatus(error: unknown): 404 | 409 | 503 {
  const code = findCodedError(error)?.code;

  if (code === 'no_such_session') {
    return 404;
  }

  if (code === 'session_dead') {
    return 409;
  }

  return 503;
}
