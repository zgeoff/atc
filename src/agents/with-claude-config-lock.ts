import { mkdir, rmdir, stat } from 'node:fs/promises';

// A lock older than this belongs to a holder that died: the Claude CLI's
// lock library refreshes a held lock's age well inside it.
const STALE_MS = 10_000;

// How long a caller waits for the lock before it gives up.
const WAIT_MS = 5000;
const RETRY_MS = 50;

/**
 * Runs the callback while holding the lock the Claude CLI takes before it
 * writes its global config: a directory beside the file named for it with
 * a `.lock` suffix, created with `mkdir` so only one holder succeeds. A
 * lock left by a dead holder is taken over once it goes stale. Waiting
 * longer than a few seconds throws without running the callback.
 */
export async function withClaudeConfigLock<T>(
  configPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configPath}.lock`;
  const deadline = Date.now() + WAIT_MS;

  while (!(await tryCreateLockDir(lockPath))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the Claude config lock ${lockPath}`);
    }

    await Bun.sleep(RETRY_MS);
  }

  try {
    return await run();
  } finally {
    await rmdir(lockPath).catch(() => {});
  }
}

// Creates the lock directory and resolves to whether this call holds the
// lock; a stale directory is removed so the next try can take it.
async function tryCreateLockDir(lockPath: string): Promise<boolean> {
  try {
    await mkdir(lockPath);

    return true;
  } catch (error) {
    if (!isExistsError(error)) {
      throw error;
    }
  }

  const held = await stat(lockPath).catch(() => null);

  if (held !== null && Date.now() - held.mtimeMs > STALE_MS) {
    await rmdir(lockPath).catch(() => {});
  }

  return false;
}

function isExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
