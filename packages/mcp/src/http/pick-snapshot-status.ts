import { AtcError } from '@atcx/contract/light';

export function pickSnapshotStatus(error: unknown): 404 | 409 | 503 {
  if (error instanceof AtcError && error.code === 'no_such_session') {
    return 404;
  }

  if (error instanceof AtcError && error.code === 'session_dead') {
    return 409;
  }

  return 503;
}
