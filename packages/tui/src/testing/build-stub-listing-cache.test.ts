import { expect, test } from 'bun:test';
import { LISTING_CACHE_LIFETIME_MS } from '../listing-cache';
import { buildStubListingCache } from './build-stub-listing-cache';

test('it finds the listing written under a key', async () => {
  const cache = buildStubListingCache();

  await cache.writeListing('github', { candidates: ['acme/app'], scope: 'acme', listedAt: 1000 });

  expect(cache.readListing('github', 2000)).toStrictEqual({
    candidates: ['acme/app'],
    scope: 'acme',
    listedAt: 1000,
  });
});

test('it finds no listing under a key nothing was written under', () => {
  const cache = buildStubListingCache();

  expect(cache.readListing('github', 2000)).toBeNull();
});

test('it finds a listing exactly as old as the lifetime', async () => {
  const cache = buildStubListingCache();

  await cache.writeListing('github', { candidates: [], scope: 'acme', listedAt: 1000 });

  expect(cache.readListing('github', 1000 + LISTING_CACHE_LIFETIME_MS)).toStrictEqual({
    candidates: [],
    scope: 'acme',
    listedAt: 1000,
  });
});

test('it finds no listing older than the lifetime', async () => {
  const cache = buildStubListingCache();

  await cache.writeListing('github', { candidates: [], scope: 'acme', listedAt: 1000 });

  expect(cache.readListing('github', 1001 + LISTING_CACHE_LIFETIME_MS)).toBeNull();
});

test('it keeps the listing requested later when an earlier request writes after it', async () => {
  const cache = buildStubListingCache();

  await cache.writeListing('github', { candidates: ['later'], scope: 'acme', listedAt: 2000 });
  await cache.writeListing('github', { candidates: ['earlier'], scope: 'acme', listedAt: 1000 });

  expect(cache.readListing('github', 3000)).toStrictEqual({
    candidates: ['later'],
    scope: 'acme',
    listedAt: 2000,
  });
});
