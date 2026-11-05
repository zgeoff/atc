import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { readCallbackVerifiedAt } from './read-callback-verified-at';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-read-callback-verified-at-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db };
}

test("it reads when a client's callback URL was last verified", async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_event_callback')
    .values([
      {
        client_id: 'client-one',
        url: 'https://hooks.example.com/hook',
        verified_at: '2026-10-23T12:00:00.000Z',
      },
      {
        client_id: 'client-two',
        url: 'https://hooks.example.com/hook',
        verified_at: '2026-10-24T12:00:00.000Z',
      },
    ])
    .execute();

  const verifiedAt = await readCallbackVerifiedAt(
    ctx.db,
    'client-one',
    'https://hooks.example.com/hook',
  );

  expect(verifiedAt).toBe('2026-10-23T12:00:00.000Z');
});

test('it reads null for a callback URL the client never verified', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('atc_event_callback')
    .values({
      client_id: 'client-one',
      url: 'https://hooks.example.com/hook',
      verified_at: '2026-10-23T12:00:00.000Z',
    })
    .execute();

  const verifiedAt = await readCallbackVerifiedAt(
    ctx.db,
    'client-one',
    'https://hooks.example.com/other',
  );

  expect(verifiedAt).toBeNull();
});
