import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/test-utils';
import { createTestDatabase } from '@zgeoff/mcp-auth/testing';
import { seedOwnerSchema } from './seed-owner-schema';

function setupTest() {
  const sqlite = createTestDatabase();

  registerTestCleanup(() => {
    sqlite.close();
  });

  return { sqlite };
}

test('it writes the one owner row that every grant points at', () => {
  const ctx = setupTest();
  const owner = seedOwnerSchema(ctx.sqlite);

  expect(ctx.sqlite.query('select "id", "name", "email" from "user"').all()).toStrictEqual([
    { id: owner.ownerID, name: 'owner', email: 'owner@atc.invalid' },
  ]);
});

test('it makes the grant use table and atc passkey tables beside the OAuth tables', () => {
  const ctx = setupTest();

  seedOwnerSchema(ctx.sqlite);

  expect(
    ctx.sqlite
      .query(
        "select name from sqlite_master where type = 'table' and name like 'atc_%' order by name",
      )
      .all(),
  ).toStrictEqual([
    { name: 'atc_enrollment_token' },
    { name: 'atc_grant_use' },
    { name: 'atc_passkey' },
  ]);
});
