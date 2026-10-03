import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunSqliteDriver } from './bun-sqlite-driver';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'atc-driver-'));

  const sqlite = new Database(join(dir, 'state.db'), { create: true });

  return {
    driver: new BunSqliteDriver(sqlite),
    [Symbol.asyncDispose]() {
      sqlite.close();

      rmSync(dir, { recursive: true, force: true });

      return Promise.resolve();
    },
  };
}

test('it lets a second acquireConnection through only after the first releaseConnection', async () => {
  await using ctx = setupTest();

  await ctx.driver.acquireConnection();

  let secondAcquired = false;

  const second = (async () => {
    await ctx.driver.acquireConnection();

    secondAcquired = true;
  })();

  // Two microtask drains: enough for the waiting acquire to resume if
  // nothing were holding the connection.
  await Promise.resolve();
  await Promise.resolve();

  expect(secondAcquired).toBe(false);

  await ctx.driver.releaseConnection();

  await second;

  expect(secondAcquired).toBe(true);
});
