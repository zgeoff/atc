import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@atc/core/is-record';
import type { Clock } from '@atc/core/system-clock';
import { systemClock } from '@atc/core/system-clock';
import { waitUntil } from '@atc/core/wait-until';
import { isProcessAlive } from '@atc/lifecycle/is-process-alive';

/**
 * One source listing as the daemon answered it: the candidates as they
 * came over the wire, the scope the daemon listed them under, and when
 * the request for it went out, in milliseconds since the epoch.
 */
interface CachedListing {
  readonly candidates: readonly unknown[];
  readonly scope: string | null;
  readonly listedAt: number;
}

/**
 * The source listings a client keeps between opens of the spawn picker,
 * and between client runs. Finding returns the listing kept under a key,
 * or null when none is kept or the kept one is older than the lifetime.
 * Writing keeps a listing under a key, replacing the one there unless
 * that one was requested later, so a slow answer to an earlier request
 * never replaces a newer listing. A write resolves once the listing is
 * kept or given up on, and never rejects.
 */
export interface ListingCache {
  readonly findListing: (key: string, now: number) => CachedListing | null;
  readonly writeListing: (key: string, listing: CachedListing) => Promise<void>;
}

/**
 * Tuning a caller may pass: the clock that times the wait for the lock.
 */
interface ListingCacheOptions {
  readonly clock?: Clock;
}

// How long a kept listing is shown before the picker waits for a fresh
// one: a day.
export const LISTING_CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;

// How long a write waits for the lock before it gives up, and how often
// it tries again meanwhile.
const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 10;

/**
 * The listing cache in one JSON file. Each read and each write opens the
 * file again, so clients that share it see each other's listings. A file
 * that is missing or does not parse holds no listings, and a write that
 * fails keeps nothing: a cache never stops a listing. A write goes
 * through a temporary file and a rename, so a reader never sees half a
 * file. Each write reads, checks, and replaces the file while it holds a
 * lock beside it, so writers in several processes keep each other's
 * listings. The lock is a directory named for the file with a `.lock`
 * suffix, holding one file named for the write that holds it and its
 * process. A lock whose process has exited is taken over, and a write
 * that waits too long for the lock keeps nothing.
 */
export function openListingCache(file: string, options: ListingCacheOptions = {}): ListingCache {
  const clock = options.clock ?? systemClock;
  const lockPath = `${file}.lock`;

  return {
    findListing(key, now) {
      const listing = loadListings(file).get(key);

      if (listing === undefined || now - listing.listedAt > LISTING_CACHE_LIFETIME_MS) {
        return null;
      }

      return listing;
    },
    async writeListing(key, listing) {
      const token = `${process.pid}-${randomUUID()}`;
      let claimed = false;

      try {
        claimed = await waitUntil(() => tryClaimLock(lockPath, token), {
          clock,
          intervalMs: LOCK_RETRY_MS,
          deadlineMs: clock.now() + LOCK_WAIT_MS,
        });
      } catch {
        return;
      }

      if (!claimed) {
        return;
      }

      try {
        writeListingUnderLock(file, key, listing);
      } finally {
        releaseLock(lockPath, token);
      }
    },
  };
}

// Builds a lock directory holding the token file beside the lock, then
// renames it into place and returns true when this call now holds the
// lock. A rename never replaces a directory that holds a file, so it
// fails while another write holds the lock; a lock whose process has
// exited is then removed so the next try can take it. A folder that cannot
// hold the lock throws.
function tryClaimLock(lockPath: string, token: string): boolean {
  const stagedPath = `${lockPath}.${token}`;

  try {
    mkdirSync(stagedPath);
    writeFileSync(join(stagedPath, token), '');
    renameSync(stagedPath, lockPath);

    return true;
  } catch (error) {
    rmSync(stagedPath, { recursive: true, force: true });

    if (!(error instanceof Error && 'code' in error && isLockHeldCode(error.code))) {
      throw error;
    }
  }

  removeStaleLock(lockPath);

  return false;
}

function isLockHeldCode(code: unknown): boolean {
  return code === 'ENOTEMPTY' || code === 'EEXIST';
}

// Removes each token file whose process has exited, then the lock
// directory if that left it empty. A live writer keeps its lock however
// long it pauses, so it never replaces the file after another write.
// Removing a token by its own name and the directory only while empty
// never removes a lock that another write took in the meantime.
function removeStaleLock(lockPath: string): void {
  try {
    for (const name of readdirSync(lockPath)) {
      const pid = Number(name.split('-')[0]);

      if (!(Number.isInteger(pid) && pid > 0 && isProcessAlive(pid))) {
        unlinkSync(join(lockPath, name));
      }
    }

    rmdirSync(lockPath);
  } catch {}
}

// How many listings the file keeps; the oldest go first.
const MAX_LISTINGS = 32;

// Keeps the listing in the file unless the one there was requested later,
// dropping listings past the lifetime and past the most the file keeps.
// The caller holds the lock.
function writeListingUnderLock(file: string, key: string, listing: CachedListing): void {
  const listings = loadListings(file);
  const kept = listings.get(key);

  if (kept !== undefined && kept.listedAt > listing.listedAt) {
    return;
  }

  listings.delete(key);
  listings.set(key, listing);

  const retained = [...listings]
    .filter(([, entry]) => listing.listedAt - entry.listedAt <= LISTING_CACHE_LIFETIME_MS)
    .toSorted(([, a], [, b]) => b.listedAt - a.listedAt)
    .slice(0, MAX_LISTINGS);

  const tmpFile = `${file}.${process.pid}.tmp`;

  try {
    writeFileSync(tmpFile, JSON.stringify({ listings: Object.fromEntries(retained) }));
    renameSync(tmpFile, file);
  } catch {
    try {
      rmSync(tmpFile, { force: true });
    } catch {}
  }
}

// Removes this write's token file, then the lock directory. A lock that
// another write took over holds no such token, so it stays.
function releaseLock(lockPath: string, token: string): void {
  try {
    unlinkSync(join(lockPath, token));
    rmdirSync(lockPath);
  } catch {}
}

// The listings the file holds, leaving out each entry that does not parse.
function loadListings(file: string): Map<string, CachedListing> {
  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }

  const listings = isRecord(raw) ? raw['listings'] : undefined;

  if (!isRecord(listings)) {
    return new Map();
  }

  return new Map(
    Object.entries(listings).flatMap(([key, entry]) => {
      const listing = parseListing(entry);

      return listing === null ? [] : [[key, listing] as const];
    }),
  );
}

function parseListing(entry: unknown): CachedListing | null {
  if (
    !isRecord(entry) ||
    !Array.isArray(entry['candidates']) ||
    typeof entry['listedAt'] !== 'number' ||
    !(entry['scope'] === null || typeof entry['scope'] === 'string')
  ) {
    return null;
  }

  return { candidates: entry['candidates'], scope: entry['scope'], listedAt: entry['listedAt'] };
}
