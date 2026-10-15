import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { createEnrollmentToken } from './create-enrollment-token';
import { deriveTokenHash } from './derive-token-hash';
import { findEnrollmentToken } from './find-enrollment-token';
import { openMCPAuth } from './open-mcp-auth';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const tmp = setupTempDir('atc-find-enrollment-token-');

  const store = await openMCPAuth({
    dbPath: join(tmp.dir, 'mcp-auth.db'),
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it finds the hash of a minted token before it expires', async () => {
  const ctx = await setupTest();
  const minted = await createEnrollmentToken(ctx.db, 1_000_000);
  const found = await findEnrollmentToken(ctx.db, minted.token, 1_000_000 + 899_999);

  expect(found).toBe(deriveTokenHash(minted.token));
});

test('it finds nothing for a token once it expired', async () => {
  const ctx = await setupTest();
  const minted = await createEnrollmentToken(ctx.db, 1_000_000);
  const found = await findEnrollmentToken(ctx.db, minted.token, 1_000_000 + 900_000);

  expect(found).toBeNull();
});

test('it finds nothing for a token it never minted', async () => {
  const ctx = await setupTest();

  await createEnrollmentToken(ctx.db, 1_000_000);

  const found = await findEnrollmentToken(ctx.db, 'atc-enroll-guessed', 1_000_000);

  expect(found).toBeNull();
});
