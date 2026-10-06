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

  let owned: OwnedLock = held;
  let refreshing = Promise.resolve();

  const timer = setInterval(() => {
    refreshing = (async () => {
      const refreshed = await refreshOwnedLock(lockPath, owned);

      owned = refreshed ?? owned;
    })();
  }, REFRESH_MS);

  try {
    return await run();
  } finally {
    clearInterval(timer);

    await refreshing;

    const isOwned = await isOwnedLock(lockPath, owned);

    if (isOwned) {
      await rmdir(lockPath).catch(() => {});
    }
  }
}

// The lock directory a holder created, as its inode and the age it last
// gave it; a directory created in its place after a takeover can reuse
// the inode but not that age.
interface OwnedLock {
  readonly ino: number;
  readonly mtimeMs: number;
}

// Creates the lock directory and resolves to it while this call holds the
// lock, or null; a stale directory is removed so the next try can take it.
async function tryCreateLockDir(lockPath: string): Promise<OwnedLock | null> {
  try {
    await mkdir(lockPath);

    const created = await stat(lockPath);

    return { ino: created.ino, mtimeMs: created.mtimeMs };
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
// created, and resolves to the lock as it then stands; null leaves the
// lock to go stale, as a holder that stopped refreshing it does.
async function refreshOwnedLock(lockPath: string, owned: OwnedLock): Promise<OwnedLock | null> {
  const isOwned = await isOwnedLock(lockPath, owned);

  if (!isOwned) {
    return null;
  }

  try {
    const now = new Date();

    await utimes(lockPath, now, now);

    const refreshed = await stat(lockPath);

    return { ino: refreshed.ino, mtimeMs: refreshed.mtimeMs };
  } catch {
    return null;
  }
}

async function isOwnedLock(lockPath: string, owned: OwnedLock): Promise<boolean> {
  const current = await stat(lockPath).catch(() => null);

  return current !== null && current.ino === owned.ino && current.mtimeMs === owned.mtimeMs;
}
