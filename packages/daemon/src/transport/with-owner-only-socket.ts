import { chmodSync } from 'node:fs';

// The umask the bind runs under, so the socket file is created without any
// group or other bits and no other user can connect before the chmod.
const OWNER_ONLY_UMASK = 0o077;

// The socket file's mode once bound: read and write for the owner alone.
const OWNER_ONLY_SOCKET_MODE = 0o600;

// a connection on a daemon socket acts as the daemon's owner, so the mode holds whatever the
// process umask and the directory's mode are
export function withOwnerOnlySocket<T>(path: string, bind: () => T): T {
  const previous = process.umask(OWNER_ONLY_UMASK);
  let bound: T;

  try {
    bound = bind();
  } finally {
    process.umask(previous);
  }

  chmodSync(path, OWNER_ONLY_SOCKET_MODE);

  return bound;
}
