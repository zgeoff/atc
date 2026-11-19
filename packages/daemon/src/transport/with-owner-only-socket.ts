import { chmodSync } from 'node:fs';

// Binding creates the socket with the process umask applied. Running the bind under this one
// leaves no window where another user can connect before the mode is set.
const OWNER_ONLY_UMASK = 0o077;
const OWNER_ONLY_SOCKET_MODE = 0o600;

// Anyone who can connect to a daemon socket acts as the daemon's owner, so the socket must be
// owner only whatever the process umask and the directory's mode are.
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
