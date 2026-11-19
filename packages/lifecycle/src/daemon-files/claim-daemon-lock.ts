import { FFIType, dlopen, ptr } from 'bun:ffi';
import { closeSync, writeFileSync } from 'node:fs';
import type { Clock } from '@atc/core';
import { systemClock } from '@atc/core';

export interface DaemonLock {
  readonly dispose: () => void;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const O_RDWR = 2;

// Close-on-exec: flock locks live on the open file description, so a child that inherits
// the fd would keep a dead daemon's lock held.
const O_CLOEXEC = process.platform === 'darwin' ? 0x01_00_00_00 : 0o200_0000;
const RETRY_MS = 50;

// Never remove the lock file: flock binds to the inode, so a newcomer would lock a fresh
// inode while an older daemon still holds the unlinked one.
export async function claimDaemonLock(
  lockPath: string,
  waitMs: number,
  clock: Clock = systemClock,
): Promise<DaemonLock | null> {
  writeFileSync(lockPath, '', { flag: 'a' });

  const libc = openLibc();
  const fd = libc.symbols.open(ptr(Buffer.from(`${lockPath}\0`)), O_RDWR | O_CLOEXEC);

  if (fd < 0) {
    throw new Error(`atc daemon: cannot open the lock file ${lockPath}`);
  }

  const deadline = clock.now() + waitMs;

  while (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    if (clock.now() >= deadline) {
      closeSync(fd);

      return null;
    }

    await new Promise<void>((resolve) => {
      clock.schedule(resolve, RETRY_MS);
    });
  }

  let held = true;

  return {
    dispose: () => {
      if (held) {
        held = false;

        closeSync(fd);
      }
    },
  };
}

// C declares open as variadic; two arguments are enough here because the file already
// exists and no mode is passed.
function openLibc() {
  const libcPath = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

  return dlopen(libcPath, {
    open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}
