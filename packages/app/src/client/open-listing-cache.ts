import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isRecord } from '@atc/core/is-record';

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
 * never replaces a newer listing.
 */
export interface ListingCache {
  readonly findListing: (key: string, now: number) => CachedListing | null;
  readonly writeListing: (key: string, listing: CachedListing) => void;
}

// How long a kept listing is shown before the picker waits for a fresh
// one: a day.
export const LISTING_CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;

// How many listings the file keeps; the oldest go first.
const MAX_LISTINGS = 32;

/**
 * The listing cache in one JSON file. Each read and each write opens the
 * file again, so clients that share it see each other's listings. A file
 * that is missing or does not parse holds no listings, and a write that
 * fails keeps nothing: a cache never stops a listing. A write goes
 * through a temporary file and a rename, so a reader never sees half a
 * file.
 */
export function openListingCache(file: string): ListingCache {
  return {
    findListing(key, now) {
      const listing = loadListings(file).get(key);

      if (listing === undefined || now - listing.listedAt > LISTING_CACHE_LIFETIME_MS) {
        return null;
      }

      return listing;
    },
    writeListing(key, listing) {
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
    },
  };
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
