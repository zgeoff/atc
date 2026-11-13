import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openATCAuthAdmin } from '@atc/mcp';
import type { PasskeyID } from '@atc/mcp';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { toTagged } from '@zgeoff/std';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { seedATCPasskey } from './seed-atc-passkey';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-seed-atc-passkey-');
  const sqlite = openMCPAuthDatabase(join(temporaryDirectory.path, 'mcp-auth.db'));

  registerTestCleanup(() => {
    sqlite.close();
  });

  const admin = await openATCAuthAdmin(sqlite, { now: () => Date.now() });

  registerTestCleanup(() => admin.close());

  return { sqlite, admin };
}

test('it writes a passkey the admin lists, never used', async () => {
  const ctx = await setupTest();

  seedATCPasskey(ctx.sqlite, { id: 'cred-tablet', createdAt: '2026-10-14T12:00:00.000Z' });

  expect(ctx.admin.passkeys.list()).resolves.toStrictEqual([
    {
      id: toTagged<PasskeyID>('cred-tablet'),
      createdAt: '2026-10-14T12:00:00.000Z',
      lastUsedAt: null,
    },
  ]);
});

test('it writes the last use it is given', async () => {
  const ctx = await setupTest();

  seedATCPasskey(ctx.sqlite, {
    id: 'cred-tablet',
    createdAt: '2026-10-14T12:00:00.000Z',
    lastUsedAt: '2026-10-14T13:00:00.000Z',
  });

  expect(ctx.admin.passkeys.list()).resolves.toStrictEqual([
    {
      id: toTagged<PasskeyID>('cred-tablet'),
      createdAt: '2026-10-14T12:00:00.000Z',
      lastUsedAt: '2026-10-14T13:00:00.000Z',
    },
  ]);
});
