import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { BunSqliteDriver } from './bun-sqlite-driver';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-driver-'));

  const sqlite = new Database(join(tmp.dir, 'state.db'), { create: true });

  stack.defer(() => {
    sqlite.close();
  });

  const driver = new BunSqliteDriver(sqlite);

  // Every test acquires after a first caller already holds the connection.
  await driver.acquireConnection();

  const owned = stack.move();

  return { driver, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it keeps a second acquire waiting while the first caller holds the connection', async () => {
  await using ctx = await setupTest();

  const second = ctx.driver.acquireConnection();

  await waitFor(() => {
    expect(ctx.driver.waiting).toBe(1);
  });

  expect(Bun.peek.status(second)).toBe('pending');
});

test('it hands the connection to a waiting acquire once the first caller releases it', async () => {
  await using ctx = await setupTest();

  const second = ctx.driver.acquireConnection();

  await ctx.driver.releaseConnection();

  await expect(second).toResolve();
});
