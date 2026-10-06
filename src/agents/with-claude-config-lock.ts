import { mkdir, rmdir, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';

// A lock older than this belongs to a holder that died: the Claude CLI's
// lock library refreshes a held lock's age well inside it.
const STALE_MS = 10_000;

// How often a held lock's age is refreshed, well inside the stale age.
const REFRESH_MS = 1000;

// How long a caller waits for the lock before it gives up.
const WAIT_MS = 5000;
const RETRY_MS = 50;

/**
 * Runs the callback while holding the lock the Claude CLI takes before it
 * writes its global config: a directory beside the file named for it with
 * a `.lock` suffix, created with `mkdir` so only one holder succeeds. The
 * config's folder is created first when it does not exist yet. A lock left
 * by a dead holder is taken over once it goes stale, and a held lock's age
 * is refreshed while the callback runs so no one takes it over. Release
 * removes the lock only while it is still the directory this call created.
 * Waiting longer than a few seconds throws without running the callback.
 */
export async function withClaudeConfigLock<T>(
  configPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configPath}.lock`;
  const deadline = Date.now() + WAIT_MS;

  await mkdir(dirname(configPath), { recursive: true });

  let held = await tryCreateLockDir(lockPath);

  while (held === null) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the Claude config lock ${lockPath}`);
    }

    await Bun.sleep(RETRY_MS);

    held = await tryCreateLockDir(lockPath);
  }

  const owned = held;

  const timer = setInterval(() => {
    void refreshOwnedLock(lockPath, owned);
  }, REFRESH_MS);

  try {
    return await run();
  } finally {
    clearInterval(timer);

    const isOwned = await isOwnedLock(lockPath, owned);

    if (isOwned) {
      await rmdir(lockPath).catch(() => {});
    }
  }
}

// Creates the lock directory and resolves to its inode while this call
// holds the lock, or null; a stale directory is removed so the next try
// can take it.
async function tryCreateLockDir(lockPath: string): Promise<number | null> {
  try {
    await mkdir(lockPath);

    const created = await stat(lockPath);

    return created.ino;
  } catch (error) {
    if (!isExistsError(error)) {
      throw error;
    }
  }

  const existing = await stat(lockPath).catch(() => null);

  if (existing !== null && Date.now() - existing.mtimeMs > STALE_MS) {
    await rmdir(lockPath).catch(() => {});
  }

  return null;
}

function isExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

// Moves the lock's age forward while it is still the directory this call
// created; a failed refresh leaves the lock to go stale.
async function refreshOwnedLock(lockPath: string, owned: number): Promise<void> {
  const isOwned = await isOwnedLock(lockPath, owned);

  if (isOwned) {
    const now = new Date();

    await utimes(lockPath, now, now).catch(() => {});
  }
}

async function isOwnedLock(lockPath: string, owned: number): Promise<boolean> {
  const current = await stat(lockPath).catch(() => null);

  return current !== null && current.ino === owned;
}
