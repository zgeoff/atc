import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/test-utils';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { seedOwnerGrantUse } from './seed-owner-grant-use';
import { seedOwnerSchema } from './seed-owner-schema';

function setupTest() {
  const sqlite = createTestDatabase();

  registerTestCleanup(() => {
    sqlite.close();
  });

  seedOwnerSchema(sqlite);

  return { sqlite };
}

test('it writes the last use of the grant it is given', () => {
  const ctx = setupTest();

  seedOwnerGrantUse(ctx.sqlite, { grantID: 'code-fig-3', lastUsedAt: '2026-10-14T12:00:00.000Z' });

  expect(ctx.sqlite.query('select grant_id, last_used_at from atc_grant_use').all()).toStrictEqual([
    { grant_id: 'code-fig-3', last_used_at: '2026-10-14T12:00:00.000Z' },
  ]);
});
