import { LISTING_CACHE_LIFETIME_MS } from '../listing-cache';
import type { CachedListing, ListingCache } from '../listing-cache';

// The listing cache contract in memory: a read past the lifetime finds
// nothing, and a write for an older request never replaces a newer one.
export function buildStubListingCache(): ListingCache {
  const listings = new Map<string, CachedListing>();

  return {
    readListing: (key, now) => {
      const listing = listings.get(key);

      return listing === undefined || now - listing.listedAt > LISTING_CACHE_LIFETIME_MS
        ? null
        : listing;
    },
    writeListing: (key, listing) => {
      const kept = listings.get(key);

      if (kept === undefined || kept.listedAt <= listing.listedAt) {
        listings.set(key, listing);
      }

      return Promise.resolve();
    },
  };
}
