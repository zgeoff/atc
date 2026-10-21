export interface CachedListing {
  readonly candidates: readonly unknown[];
  readonly scope: string | null;

  // when the request went out, so a slow answer never outranks a later request.
  readonly listedAt: number;
}

// The git listings the spawn picker shows at once while it lists again. A
// read past the lifetime finds nothing.
export interface ListingCache {
  readonly readListing: (key: string, now: number) => CachedListing | null;

  // resolves once the listing is kept or given up on, and never rejects.
  readonly writeListing: (key: string, listing: CachedListing) => Promise<void>;
}

// How long a kept listing is shown before the picker waits for a fresh
// one: a day.
export const LISTING_CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;
