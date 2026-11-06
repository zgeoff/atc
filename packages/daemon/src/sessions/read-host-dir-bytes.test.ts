import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { buildStubLocalProvider } from '../testing/build-stub-local-provider';
import { readHostDirBytes } from './read-host-dir-bytes';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-host-dir-bytes-');

  return { directory: temporaryDirectory.path, provider: buildStubLocalProvider() };
}

test('it reads the disk space a folder takes as a whole number of KiB', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'loaf.bin'), Buffer.alloc(64 * 1024, 1));

  const bytes = await readHostDirBytes(ctx.provider, null, ctx.directory);

  expect(bytes).toSatisfy(
    (value: number | null) => value !== null && value >= 64 * 1024 && value % 1024 === 0,
  );
});

test('it reads null for a folder that is not there', async () => {
  const ctx = setupTest();

  const bytes = await readHostDirBytes(ctx.provider, null, join(ctx.directory, 'gone'));

  expect(bytes).toBeNull();
});
