import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { PasskeyID } from '@atc/mcp';
import { setupTempDir } from '@atc/test-utils';
import { toTagged } from '@zgeoff/std';
import { openTestAuthAdmin } from './open-test-auth-admin';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-open-test-auth-admin-');

  return { dbPath: join(temporaryDirectory.path, 'state', 'mcp-auth.db') };
}

test('it seeds a passkey the admin lists', async () => {
  const ctx = setupTest();

  const opened = await openTestAuthAdmin(ctx.dbPath);

  opened.seedPasskey({
    id: 'cred-phone',
    createdAt: '2026-10-14T12:00:00.000Z',
    lastUsedAt: '2026-10-14T13:00:00.000Z',
  });

  expect(opened.admin.passkeys.list()).resolves.toStrictEqual([
    {
      id: toTagged<PasskeyID>('cred-phone'),
      createdAt: '2026-10-14T12:00:00.000Z',
      lastUsedAt: '2026-10-14T13:00:00.000Z',
    },
  ]);
});

test('it counts the enrollment tokens the admin made', async () => {
  const ctx = setupTest();

  const opened = await openTestAuthAdmin(ctx.dbPath);

  await opened.admin.passkeys.createEnrollmentToken();

  expect(opened.countEnrollmentTokens()).toBe(1);
});

test('it opens the event tables on the same database', async () => {
  const ctx = setupTest();

  const opened = await openTestAuthAdmin(ctx.dbPath);

  expect(
    opened.events.selectFrom('atc_event_subscription').selectAll().execute(),
  ).resolves.toStrictEqual([]);
});
