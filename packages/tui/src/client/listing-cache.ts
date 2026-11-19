export interface CachedListing {
  readonly candidates: readonly unknown[];
  readonly scope: string | null;

  readonly listedAt: number;
}

export interface ListingCache {
  readonly readListing: (key: string, now: number) => CachedListing | null;

  readonly writeListing: (key: string, listing: CachedListing) => Promise<void>;
}

export const LISTING_CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;
