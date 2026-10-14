import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubSkipClock } from '@atc/test-utils/build-stub-skip-clock';
import { runCommand } from '@atc/test-utils/run-command';
import { waitFor } from '@atc/test-utils/wait-for';
import { LISTING_CACHE_LIFETIME_MS, openListingCache } from './open-listing-cache';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'atc-listing-cache-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, file: join(dir, 'listing-cache.json') };
}

test('it finds a listing that a cache opened earlier on the same file wrote', async () => {
  const ctx = setupTest();

  await openListingCache(ctx.file).writeListing('github', {
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

test('it finds no listing under a key nothing was written under', async () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  await cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.findListing('gitlab', 1_000_000)).toBeNull();
});

test('it finds a listing exactly as old as the lifetime', async () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  await cache.writeListing('github', {
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

test('it finds no listing older than the lifetime', async () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  await cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.findListing('github', 1_000_001 + LISTING_CACHE_LIFETIME_MS)).toBeNull();
});

test('it keeps a day as the lifetime', () => {
  expect(LISTING_CACHE_LIFETIME_MS).toBe(86_400_000);
});

test('it replaces the listing under a key with the one written last', async () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  await cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  await cache.writeListing('github', {
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

test('it keeps the listing requested later when an earlier request writes after it', async () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  await cache.writeListing('github', {
    candidates: [{ label: 'acme/new-tool' }],
    scope: null,
    listedAt: 2_000_000,
  });

  await cache.writeListing('github', {
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

test('it drops listings older than the lifetime when it writes another', async () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  await cache.writeListing('old', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  await cache.writeListing('new', {
    candidates: [{ label: 'acme/docs' }],
    scope: null,
    listedAt: 1_000_001 + LISTING_CACHE_LIFETIME_MS,
  });

  expect(cache.findListing('old', 1_000_000)).toBeNull();
});

test('it keeps the 32 newest listings and drops the rest', async () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  for (let i = 0; i < 33; i += 1) {
    await cache.writeListing(`key-${i}`, {
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

test('it keeps nothing and leaves no temporary file when the folder cannot be written', async () => {
  const ctx = setupTest();
  const file = join(ctx.dir, 'missing', 'listing-cache.json');
  const cache = openListingCache(file);

  await cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.findListing('github', 1_000_000)).toBeNull();
  expect(readdirSync(ctx.dir)).toStrictEqual([]);
});

test('it keeps every write from writers in several processes, and the latest request for a key', async () => {
  const ctx = setupTest();

  // Each writer waits for the go file once it is ready, so all four write
  // at the same time.
  const writers = Array.from({ length: 4 }, (_, writer) =>
    runCommand([
      process.execPath,
      '-e',
      `const { openListingCache } = await import(${JSON.stringify(join(import.meta.dir, 'open-listing-cache.ts'))});
const cache = openListingCache(${JSON.stringify(ctx.file)});
await Bun.write(${JSON.stringify(join(ctx.dir, `ready-${writer}`))}, '');
while (!(await Bun.file(${JSON.stringify(join(ctx.dir, 'go'))}).exists())) {
  await Bun.sleep(1);
}
for (let round = 0; round < 6; round += 1) {
  await cache.writeListing('writer-${writer}-' + round, {
    candidates: [{ label: 'acme/app-${writer}-' + round }],
    scope: null,
    listedAt: 1_000_000 + round,
  });
  await cache.writeListing('shared', {
    candidates: [{ label: 'acme/shared-${writer}-' + round }],
    scope: null,
    listedAt: 2_000_000 + round * 4 + ${writer},
  });
}`,
    ]),
  );

  await waitFor(() => {
    expect(readdirSync(ctx.dir)).toIncludeAllMembers(['ready-0', 'ready-1', 'ready-2', 'ready-3']);
  });

  writeFileSync(join(ctx.dir, 'go'), '');

  const runs = await Promise.all(writers);

  const cache = openListingCache(ctx.file);

  expect(runs.map((run) => run.exitCode)).toStrictEqual([0, 0, 0, 0]);

  expect(
    Array.from({ length: 24 }, (_, i) =>
      cache.findListing(`writer-${Math.floor(i / 6)}-${i % 6}`, 2_000_100),
    ),
  ).toStrictEqual(
    Array.from({ length: 24 }, (_, i) => ({
      candidates: [{ label: `acme/app-${Math.floor(i / 6)}-${i % 6}` }],
      scope: null,
      listedAt: 1_000_000 + (i % 6),
    })),
  );

  expect(cache.findListing('shared', 2_000_100)).toStrictEqual({
    candidates: [{ label: 'acme/shared-3-5' }],
    scope: null,
    listedAt: 2_000_023,
  });
});

test('it takes over a lock that a writer which died left behind', async () => {
  const ctx = setupTest();
  const lockPath = `${ctx.file}.lock`;

  const leftAt = new Date(Date.now() - 60_000);

  mkdirSync(lockPath);
  utimesSync(lockPath, leftAt, leftAt);

  await openListingCache(ctx.file).writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(openListingCache(ctx.file).findListing('github', 1_000_000)).toStrictEqual({
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(readdirSync(ctx.dir)).toStrictEqual(['listing-cache.json']);
});

test('it keeps nothing and leaves the lock alone when another writer holds it past the wait', async () => {
  const ctx = setupTest();
  const lockPath = `${ctx.file}.lock`;

  mkdirSync(lockPath);

  await openListingCache(ctx.file, { clock: buildStubSkipClock() }).writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(openListingCache(ctx.file).findListing('github', 1_000_000)).toBeNull();
  expect(readdirSync(ctx.dir)).toStrictEqual(['listing-cache.json.lock']);
});
