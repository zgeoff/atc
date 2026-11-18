import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { openTestAuthAdmin } from './open-test-auth-admin';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-test-auth-admin-');

  return { dbPath: join(temporaryDirectory.path, 'mcp-auth.db') };
}

test('it opens an admin that registers a client', async () => {
  const ctx = setupTest();

  const store = await openTestAuthAdmin(ctx.dbPath);
  const created = await store.admin.clients.add('dots', ['https://dots.example/cb']);

  expect(created.name).toBe('dots');
});

test('it opens an admin that issues an enrollment token', async () => {
  const ctx = setupTest();

  const store = await openTestAuthAdmin(ctx.dbPath);
  const token = await store.admin.passkeys.createEnrollmentToken();

  expect(token).toBeString();
});

test('it shares the database with a second admin opened on the same file', async () => {
  const ctx = setupTest();

  const first = await openTestAuthAdmin(ctx.dbPath);
  const second = await openTestAuthAdmin(ctx.dbPath);

  await first.admin.clients.add('dots', ['https://dots.example/cb']);

  expect(second.admin.clients.list()).resolves.toHaveLength(1);
});
