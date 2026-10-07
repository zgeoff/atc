import { FFIType, dlopen, ptr } from 'bun:ffi';
import { closeSync, writeFileSync } from 'node:fs';

export interface DaemonLock {
  // Releases the lock; safe to call more than once.
  readonly dispose: () => void;
}

const LOCK_EX = 2;
const LOCK_NB = 4;
const O_RDWR = 2;

// Kept off every child the daemon spawns, so an orphaned agent process can
// never hold a dead daemon's lock.
const O_CLOEXEC = process.platform === 'darwin' ? 0x01_00_00_00 : 0o200_0000;
const RETRY_MS = 50;

/**
 * Takes the exclusive daemon lock on the file at `lockPath`, waiting up to
 * `waitMs` for a daemon that is shutting down to let go, and resolves null
 * while another daemon holds it.
 *
 * The lock is a kernel `flock` on an open file description: two daemons
 * racing at the same instant cannot both win, and the kernel drops it when
 * the holding process dies, so a crashed daemon never blocks the next one.
 * The file is never removed: removing it would let a newcomer lock a fresh
 * inode while an older daemon still holds the unlinked one.
 */
export async function claimDaemonLock(
  lockPath: string,
  waitMs: number,
): Promise<DaemonLock | null> {
  writeFileSync(lockPath, '', { flag: 'a' });

  const libc = openLibc();
  const fd = libc.symbols.open(ptr(Buffer.from(`${lockPath}\0`)), O_RDWR | O_CLOEXEC);

  if (fd < 0) {
    throw new Error(`atc daemon: cannot open the lock file ${lockPath}`);
  }

  const deadline = Date.now() + waitMs;

  while (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    if (Date.now() >= deadline) {
      closeSync(fd);

      return null;
    }

    await Bun.sleep(RETRY_MS);
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

// `open` is variadic in C; it is declared here with two arguments, which is
// sound because the lock file already exists and no mode is passed.
function openLibc() {
  const libcPath = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

  return dlopen(libcPath, {
    open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}
