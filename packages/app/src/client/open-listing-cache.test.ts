import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LISTING_CACHE_LIFETIME_MS, openListingCache } from './open-listing-cache';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'atc-listing-cache-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, file: join(dir, 'listing-cache.json') };
}

test('it finds a listing that a cache opened earlier on the same file wrote', () => {
  const ctx = setupTest();

  openListingCache(ctx.file).writeListing('github', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
    listedAt: 1_000_000,
  });

  expect(openListingCache(ctx.file).findListing('github', 1_060_000)).toStrictEqual({
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
    listedAt: 1_000_000,
  });
});

test('it finds no listing under a key nothing was written under', () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.findListing('gitlab', 1_000_000)).toBeNull();
});

test('it finds a listing exactly as old as the lifetime', () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.findListing('github', 1_000_000 + LISTING_CACHE_LIFETIME_MS)).toStrictEqual({
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });
});

test('it finds no listing older than the lifetime', () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.findListing('github', 1_000_001 + LISTING_CACHE_LIFETIME_MS)).toBeNull();
});

test('it keeps a day as the lifetime', () => {
  expect(LISTING_CACHE_LIFETIME_MS).toBe(86_400_000);
});

test('it replaces the listing under a key with the one written last', () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }, { label: 'acme/new-tool' }],
    scope: null,
    listedAt: 2_000_000,
  });

  expect(cache.findListing('github', 2_000_000)).toStrictEqual({
    candidates: [{ label: 'acme/app' }, { label: 'acme/new-tool' }],
    scope: null,
    listedAt: 2_000_000,
  });
});

test('it keeps the listing requested later when an earlier request writes after it', () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  cache.writeListing('github', {
    candidates: [{ label: 'acme/new-tool' }],
    scope: null,
    listedAt: 2_000_000,
  });

  cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.findListing('github', 2_000_000)).toStrictEqual({
    candidates: [{ label: 'acme/new-tool' }],
    scope: null,
    listedAt: 2_000_000,
  });
});

test('it drops listings older than the lifetime when it writes another', () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  cache.writeListing('old', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  cache.writeListing('new', {
    candidates: [{ label: 'acme/docs' }],
    scope: null,
    listedAt: 1_000_001 + LISTING_CACHE_LIFETIME_MS,
  });

  expect(cache.findListing('old', 1_000_000)).toBeNull();
});

test('it keeps the 32 newest listings and drops the rest', () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  for (let i = 0; i < 33; i += 1) {
    cache.writeListing(`key-${i}`, {
      candidates: [{ label: 'acme/app' }],
      scope: null,
      listedAt: i,
    });
  }

  const kept = Array.from({ length: 33 }, (_, i) => cache.findListing(`key-${i}`, 33));

  expect(kept.filter((listing) => listing === null)).toHaveLength(1);
  expect(kept[0]).toBeNull();
});

test('it finds no listing in a file that does not parse', () => {
  const ctx = setupTest();

  writeFileSync(ctx.file, '{"listings":');

  expect(openListingCache(ctx.file).findListing('github', 1_000_000)).toBeNull();
});

test('it leaves out an entry that does not parse and keeps the rest', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.file,
    JSON.stringify({
      listings: {
        broken: { candidates: 'acme/app', scope: null, listedAt: 1_000_000 },
        github: { candidates: [{ label: 'acme/app' }], scope: 'acme', listedAt: 1_000_000 },
      },
    }),
  );

  const cache = openListingCache(ctx.file);

  expect(cache.findListing('broken', 1_000_000)).toBeNull();

  expect(cache.findListing('github', 1_000_000)).toStrictEqual({
    candidates: [{ label: 'acme/app' }],
    scope: 'acme',
    listedAt: 1_000_000,
  });
});

test('it keeps nothing and leaves no temporary file when the folder cannot be written', () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'missing', 'listing-cache.json');
  const cache = openListingCache(file);

  cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.findListing('github', 1_000_000)).toBeNull();
  expect(readdirSync(ctx.dir)).toStrictEqual([]);
});
