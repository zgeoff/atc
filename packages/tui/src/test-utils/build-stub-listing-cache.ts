import { LISTING_CACHE_LIFETIME_MS } from '../client/listing-cache';
import type { CachedListing, ListingCache } from '../client/listing-cache';
import type { DaemonName } from '../fleet/session-key';

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

export function buildStubListingCacheOf(): (daemon: DaemonName) => ListingCache {
  const cache = buildStubListingCache();

  return () => cache;
}
