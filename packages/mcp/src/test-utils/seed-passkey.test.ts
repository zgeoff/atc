import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubClock, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuth } from '../auth/open-mcp-auth';
import { openTestAuthDatabase } from '../testing/open-test-auth-database';
import { seedPasskey } from './seed-passkey';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-seed-passkey-');

  const store = await openMCPAuth({
    dbPath: join(temporaryDirectory.path, 'mcp-auth.db'),
    openDatabase: openTestAuthDatabase,
    origin: null,
  });

  registerTestCleanup(() => store.close());

  return { db: store.db, clock: buildStubClock(Date.UTC(2026, 9, 14, 12, 0, 0)) };
}

test('it writes a passkey enrolled at the clock time, and spends the token it enrolled with', async () => {
  const ctx = await setupTest();

  await seedPasskey(ctx, { id: 'cred-phone' });

  expect(ctx.db.selectFrom('atc_passkey').selectAll().execute()).resolves.toMatchObject([
    { id: 'cred-phone', created_at: '2026-10-14T12:00:00.000Z', last_used_at: null },
  ]);

  expect(ctx.db.selectFrom('atc_enrollment_token').selectAll().execute()).resolves.toStrictEqual(
    [],
  );
});

test('it writes the input over the defaults', async () => {
  const ctx = await setupTest();

  await seedPasskey(ctx, {
    id: 'cred-laptop',
    publicKey: 'BAUG',
    counter: 3,
    transports: ['usb'],
    now: Date.UTC(2026, 9, 14, 12, 30, 0),
  });

  expect(ctx.db.selectFrom('atc_passkey').selectAll().execute()).resolves.toMatchObject([
    {
      id: 'cred-laptop',
      public_key: 'BAUG',
      counter: 3,
      transports: '["usb"]',
      created_at: '2026-10-14T12:30:00.000Z',
    },
  ]);
});
