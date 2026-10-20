import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildTarArchive } from '@atc/core';
import { setupTempDir } from '@atc/test-utils';
import { readGuestATCArchive } from './read-guest-atc-archive';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-guest-atc-archive-');

  return { directory: temporaryDirectory.path };
}

test('it reads a gzipped tar that holds the binary as an executable bin/atc', async () => {
  const ctx = setupTest();
  const atcBinary = join(ctx.directory, 'atc');

  await Bun.write(atcBinary, '#!/bin/sh\necho 1.0.0\n');

  const archive = await readGuestATCArchive(atcBinary);

  const tar = buildTarArchive([
    { path: 'bin/atc', content: '#!/bin/sh\necho 1.0.0\n', mode: 0o755 },
  ]);

  expect(gunzipSync(archive)).toStrictEqual(Buffer.from(tar));
});

test('it returns the bytes of the first read when the binary changes on disk', async () => {
  const ctx = setupTest();
  const atcBinary = join(ctx.directory, 'atc');

  await Bun.write(atcBinary, '#!/bin/sh\necho 1.0.0\n');

  const first = await readGuestATCArchive(atcBinary);

  await Bun.write(atcBinary, '#!/bin/sh\necho 2.0.0\n');

  const second = await readGuestATCArchive(atcBinary);

  expect(second).toBe(first);
});

test('it reads the binary again after a read that failed', async () => {
  const ctx = setupTest();
  const atcBinary = join(ctx.directory, 'atc');

  await readGuestATCArchive(atcBinary).catch(() => null);

  await Bun.write(atcBinary, '#!/bin/sh\necho 1.0.0\n');

  const archive = await readGuestATCArchive(atcBinary);

  const tar = buildTarArchive([
    { path: 'bin/atc', content: '#!/bin/sh\necho 1.0.0\n', mode: 0o755 },
  ]);

  expect(gunzipSync(archive)).toStrictEqual(Buffer.from(tar));
});

test('it rejects a read of a binary that does not exist', () => {
  const ctx = setupTest();

  expect(readGuestATCArchive(join(ctx.directory, 'missing-atc'))).rejects.toThrow();
});
