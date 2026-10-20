import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { createEnrollmentToken } from './create-enrollment-token';
import { deriveTokenHash } from './derive-token-hash';
import { openMCPAuth } from './open-mcp-auth';

// A temp directory that holds an authorization database, opened the way
// the server opens it.
async function setupTest() {
  const tmp = setupTempDir('atc-create-enrollment-token-');

  const store = await openMCPAuth({
    dbPath: join(tmp.path, 'mcp-auth.db'),
    openDatabase: openMCPAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, auth: store.auth };
}

test('it stores only the hash of the token it mints, with an expiry 15 minutes on', async () => {
  const ctx = await setupTest();
  const minted = await createEnrollmentToken(ctx.db, Date.UTC(2026, 9, 14, 12, 0, 0));
  const rows = await ctx.db.selectFrom('atc_enrollment_token').selectAll().execute();

  expect(minted.token).toMatch(/^atc-enroll-[\w-]{43}$/u);
  expect(minted.expiresAt).toBe(Date.UTC(2026, 9, 14, 12, 15, 0));

  expect(rows).toStrictEqual([
    {
      token_hash: deriveTokenHash(minted.token),
      created_at: '2026-10-14T12:00:00.000Z',
      expires_at: '2026-10-14T12:15:00.000Z',
    },
  ]);
});

test('it mints a different token each time', async () => {
  const ctx = await setupTest();
  const first = await createEnrollmentToken(ctx.db, 0);
  const second = await createEnrollmentToken(ctx.db, 0);

  expect(second.token).not.toBe(first.token);
});
