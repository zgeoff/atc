import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubSkipClock, runCommand, waitFor } from '@atc/test-utils';
import { LISTING_CACHE_LIFETIME_MS } from '@atc/tui';
import { openListingCache } from './open-listing-cache';

// The test end aborts a wait before the folder it polls goes.
function setupTest() {
  const testEnd = new AbortController();

  onTestFinished(() => {
    testEnd.abort(new Error('the test ended'));
  });

  const directory = mkdtempSync(join(tmpdir(), 'atc-listing-cache-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory, file: join(directory, 'listing-cache.json'), testEnd: testEnd.signal };
}

test('it finds a listing that a cache opened earlier on the same file wrote', async () => {
  const ctx = setupTest();

  await openListingCache(ctx.file).writeListing('github', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
    listedAt: 1_000_000,
  });

  expect(openListingCache(ctx.file).readListing('github', 1_060_000)).toStrictEqual({
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

  expect(cache.readListing('gitlab', 1_000_000)).toBeNull();
});

test('it finds a listing exactly as old as the lifetime', async () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  await cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.readListing('github', 1_000_000 + LISTING_CACHE_LIFETIME_MS)).toStrictEqual({
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

  expect(cache.readListing('github', 1_000_001 + LISTING_CACHE_LIFETIME_MS)).toBeNull();
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

  expect(cache.readListing('github', 2_000_000)).toStrictEqual({
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

  expect(cache.readListing('github', 2_000_000)).toStrictEqual({
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

  expect(cache.readListing('old', 1_000_000)).toBeNull();
});

test('it keeps the 32 newest listings and drops the rest', async () => {
  const ctx = setupTest();
  const cache = openListingCache(ctx.file);

  for (let index = 0; index < 33; index += 1) {
    await cache.writeListing(`key-${index}`, {
      candidates: [{ label: 'acme/app' }],
      scope: null,
      listedAt: index,
    });
  }

  const kept = Array.from({ length: 33 }, (_, index) => cache.readListing(`key-${index}`, 33));

  expect(kept.filter((listing) => listing === null)).toHaveLength(1);
  expect(kept[0]).toBeNull();
});

test('it finds no listing in a file that does not parse', () => {
  const ctx = setupTest();

  writeFileSync(ctx.file, '{"listings":');

  expect(openListingCache(ctx.file).readListing('github', 1_000_000)).toBeNull();
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

  expect(cache.readListing('broken', 1_000_000)).toBeNull();

  expect(cache.readListing('github', 1_000_000)).toStrictEqual({
    candidates: [{ label: 'acme/app' }],
    scope: 'acme',
    listedAt: 1_000_000,
  });
});

test('it keeps nothing and leaves no temporary file when the folder cannot be written', async () => {
  const ctx = setupTest();
  const file = join(ctx.directory, 'missing', 'listing-cache.json');
  const cache = openListingCache(file);

  await cache.writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(cache.readListing('github', 1_000_000)).toBeNull();
  expect(readdirSync(ctx.directory)).toStrictEqual([]);
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
await Bun.write(${JSON.stringify(join(ctx.directory, `ready-${writer}`))}, '');
while (!(await Bun.file(${JSON.stringify(join(ctx.directory, 'go'))}).exists())) {
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

  // Four Bun starts that each load the cache's imports took over 5 s on a
  // shared 2-core host, so the test end bounds this wait.
  await waitFor(
    () => {
      expect(readdirSync(ctx.directory)).toIncludeAllMembers([
        'ready-0',
        'ready-1',
        'ready-2',
        'ready-3',
      ]);
    },
    { timeoutMs: 60_000, signal: ctx.testEnd },
  );

  writeFileSync(join(ctx.directory, 'go'), '');

  const runs = await Promise.all(writers);

  const cache = openListingCache(ctx.file);

  expect(runs.map((run) => run.exitCode)).toStrictEqual([0, 0, 0, 0]);

  expect(
    Array.from({ length: 24 }, (_, index) =>
      cache.readListing(`writer-${Math.floor(index / 6)}-${index % 6}`, 2_000_100),
    ),
  ).toStrictEqual(
    Array.from({ length: 24 }, (_, index) => ({
      candidates: [{ label: `acme/app-${Math.floor(index / 6)}-${index % 6}` }],
      scope: null,
      listedAt: 1_000_000 + (index % 6),
    })),
  );

  expect(cache.readListing('shared', 2_000_100)).toStrictEqual({
    candidates: [{ label: 'acme/shared-3-5' }],
    scope: null,
    listedAt: 2_000_023,
  });
});

test('it takes over a lock that a writer which exited left behind', async () => {
  const ctx = setupTest();
  const lockPath = `${ctx.file}.lock`;
  const exited = Bun.spawn([process.execPath, '-e', '']);

  await exited.exited;

  const exitedPid = exited.pid;

  mkdirSync(lockPath);
  writeFileSync(join(lockPath, `${exitedPid}-dead-writer`), '');

  await openListingCache(ctx.file).writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(openListingCache(ctx.file).readListing('github', 1_000_000)).toStrictEqual({
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(readdirSync(ctx.directory)).toStrictEqual(['listing-cache.json']);
});

test('it keeps nothing and leaves an old lock alone while the writer holding it still runs', async () => {
  const ctx = setupTest();
  const lockPath = `${ctx.file}.lock`;
  const tokenPath = join(lockPath, `${process.pid}-live-writer`);

  const takenAt = new Date(Date.now() - 60_000);

  mkdirSync(lockPath);
  writeFileSync(tokenPath, '');
  utimesSync(tokenPath, takenAt, takenAt);

  await openListingCache(ctx.file, { clock: buildStubSkipClock() }).writeListing('github', {
    candidates: [{ label: 'acme/app' }],
    scope: null,
    listedAt: 1_000_000,
  });

  expect(openListingCache(ctx.file).readListing('github', 1_000_000)).toBeNull();
  expect(readdirSync(ctx.directory)).toStrictEqual(['listing-cache.json.lock']);
  expect(readdirSync(lockPath)).toStrictEqual([`${process.pid}-live-writer`]);
});

test('it keeps every write when writers in several processes take over one stale lock at once', async () => {
  const ctx = setupTest();
  const lockPath = `${ctx.file}.lock`;
  const exited = Bun.spawn([process.execPath, '-e', '']);

  await exited.exited;

  const exitedPid = exited.pid;

  mkdirSync(lockPath);
  writeFileSync(join(lockPath, `${exitedPid}-dead-writer`), '');

  // Each writer waits for the go file once it is ready, so all four find
  // the stale lock at the same time.
  const writers = Array.from({ length: 4 }, (_, writer) =>
    runCommand([
      process.execPath,
      '-e',
      `const { openListingCache } = await import(${JSON.stringify(join(import.meta.dir, 'open-listing-cache.ts'))});
const cache = openListingCache(${JSON.stringify(ctx.file)});
await Bun.write(${JSON.stringify(join(ctx.directory, `ready-${writer}`))}, '');
while (!(await Bun.file(${JSON.stringify(join(ctx.directory, 'go'))}).exists())) {
  await Bun.sleep(1);
}
for (let round = 0; round < 6; round += 1) {
  await cache.writeListing('writer-${writer}-' + round, {
    candidates: [{ label: 'acme/app-${writer}-' + round }],
    scope: null,
    listedAt: 1_000_000 + round,
  });
}`,
    ]),
  );

  // Four Bun starts that each load the cache's imports took over 5 s on a
  // shared 2-core host, so the test end bounds this wait.
  await waitFor(
    () => {
      expect(readdirSync(ctx.directory)).toIncludeAllMembers([
        'ready-0',
        'ready-1',
        'ready-2',
        'ready-3',
      ]);
    },
    { timeoutMs: 60_000, signal: ctx.testEnd },
  );

  writeFileSync(join(ctx.directory, 'go'), '');

  const runs = await Promise.all(writers);

  const cache = openListingCache(ctx.file);

  expect(runs.map((run) => run.exitCode)).toStrictEqual([0, 0, 0, 0]);

  expect(
    Array.from({ length: 24 }, (_, index) =>
      cache.readListing(`writer-${Math.floor(index / 6)}-${index % 6}`, 1_000_100),
    ),
  ).toStrictEqual(
    Array.from({ length: 24 }, (_, index) => ({
      candidates: [{ label: `acme/app-${Math.floor(index / 6)}-${index % 6}` }],
      scope: null,
      listedAt: 1_000_000 + (index % 6),
    })),
  );
});
