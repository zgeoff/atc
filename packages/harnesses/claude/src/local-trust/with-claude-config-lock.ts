import { mkdir, rmdir, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Clock } from '@atc/core';
import { systemClock, waitUntil } from '@atc/core';

const REFRESH_MS = 1000;
const WAIT_MS = 5000;
const RETRY_MS = 50;

export interface ClaudeConfigLockOptions {
  readonly clock?: Clock;
  readonly onBusy?: () => void;
}

// The lock directory a holder created, as its inode and the age it last
// gave it; a directory created in its place after a takeover can reuse
// the inode but not that age.
interface OwnedLock {
  readonly ino: number;
  readonly mtimeMs: number;
}

// Matches the lock the Claude CLI takes before writing its global config: a `.lock` directory
// beside the file, made with `mkdir` so only one holder wins.
export async function withClaudeConfigLock<T>(
  configPath: string,
  run: () => Promise<T>,
  options: ClaudeConfigLockOptions = {},
): Promise<T> {
  const lockPath = `${configPath}.lock`;
  const clock = options.clock ?? systemClock;

  await mkdir(dirname(configPath), { recursive: true });

  const acquired: { lock?: OwnedLock } = {};

  await waitUntil(
    async () => {
      const held = await tryCreateLockDir(lockPath, clock);

      if (held !== null) {
        acquired.lock = held;

        return true;
      }

      options.onBusy?.();

      return false;
    },
    { clock, intervalMs: RETRY_MS, deadlineMs: clock.now() + WAIT_MS },
  );

  if (acquired.lock === undefined) {
    throw new Error(`timed out waiting for the Claude config lock ${lockPath}`);
  }

  let owned: OwnedLock = acquired.lock;
  let refreshing = Promise.resolve();

  const scheduleRefresh = (): (() => void) =>
    clock.schedule(() => {
      refreshing = (async () => {
        const refreshed = await refreshOwnedLock(lockPath, owned, clock.now());

        owned = refreshed ?? owned;
      })();

      stopRefreshing = scheduleRefresh();
    }, REFRESH_MS);

  let stopRefreshing = scheduleRefresh();

  try {
    return await run();
  } finally {
    stopRefreshing();

    await refreshing;

    const isOwned = await probeOwnedLock(lockPath, owned);

    if (isOwned) {
      await rmdir(lockPath).catch(() => {});
    }
  }
}

// A lock older than this belongs to a dead holder: the Claude CLI's lock library
// refreshes a held lock's age well inside it.
const STALE_MS = 10_000;

async function tryCreateLockDir(lockPath: string, clock: Clock): Promise<OwnedLock | null> {
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

  if (existing !== null && clock.now() - existing.mtimeMs > STALE_MS) {
    await rmdir(lockPath).catch(() => {});
  }

  return null;
}

function isExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

async function refreshOwnedLock(
  lockPath: string,
  owned: OwnedLock,
  nowMs: number,
): Promise<OwnedLock | null> {
  const isOwned = await probeOwnedLock(lockPath, owned);

  if (!isOwned) {
    return null;
  }

  try {
    const now = new Date(nowMs);

    await utimes(lockPath, now, now);

    const refreshed = await stat(lockPath);

    return { ino: refreshed.ino, mtimeMs: refreshed.mtimeMs };
  } catch {
    return null;
  }
}

async function probeOwnedLock(lockPath: string, owned: OwnedLock): Promise<boolean> {
  const current = await stat(lockPath).catch(() => null);

  return current !== null && current.ino === owned.ino && current.mtimeMs === owned.mtimeMs;
}
