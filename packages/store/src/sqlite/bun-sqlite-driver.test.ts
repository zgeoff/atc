import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { CompiledQuery } from 'kysely';
import { BunSqliteDriver } from './bun-sqlite-driver';

async function setupTest() {
  const tmp = setupTempDir('atc-driver-');

  const sqlite = new Database(join(tmp.path, 'state.db'), { create: true });

  registerTestCleanup(() => {
    sqlite.close();
  });

  const driver = new BunSqliteDriver(sqlite);

  // Every test acquires after a first caller already holds the connection.
  const connection = await driver.acquireConnection();

  return { sqlite, driver, connection };
}

test('it keeps a second acquire waiting while the first caller holds the connection', async () => {
  const ctx = await setupTest();

  const second = ctx.driver.acquireConnection();

  // An immediate fires only after every queued promise callback has run, so
  // an acquire still pending here waits on the holder and nothing else.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  expect(Bun.peek.status(second)).toBe('pending');
});

test('it hands the connection to a waiting acquire once the first caller releases it', async () => {
  const ctx = await setupTest();

  const second = ctx.driver.acquireConnection();

  await ctx.driver.releaseConnection();

  await expect(second).toResolve();
});

test('it hands the connection to waiting acquires in the order they asked', async () => {
  const ctx = await setupTest();

  const order: string[] = [];

  const second = (async () => {
    await ctx.driver.acquireConnection();

    order.push('second');

    await ctx.driver.releaseConnection();
  })();

  const third = (async () => {
    await ctx.driver.acquireConnection();

    order.push('third');
  })();

  await ctx.driver.releaseConnection();
  await Promise.all([second, third]);

  expect(order).toStrictEqual(['second', 'third']);
});

test('it keeps the writes of a committed transaction', async () => {
  const ctx = await setupTest();

  ctx.sqlite.run('CREATE TABLE notes (title TEXT NOT NULL)');

  await ctx.driver.beginTransaction(ctx.connection);
  await ctx.connection.executeQuery(CompiledQuery.raw("INSERT INTO notes (title) VALUES ('kept')"));
  await ctx.driver.commitTransaction(ctx.connection);

  expect(ctx.sqlite.query('SELECT title FROM notes').all()).toStrictEqual([{ title: 'kept' }]);
});

test('it drops the writes of a rolled-back transaction', async () => {
  const ctx = await setupTest();

  ctx.sqlite.run('CREATE TABLE notes (title TEXT NOT NULL)');

  await ctx.driver.beginTransaction(ctx.connection);

  await ctx.connection.executeQuery(
    CompiledQuery.raw("INSERT INTO notes (title) VALUES ('dropped')"),
  );

  await ctx.driver.rollbackTransaction(ctx.connection);

  expect(ctx.sqlite.query('SELECT title FROM notes').all()).toStrictEqual([]);
});

test('it answers a statement that returns columns with its rows', async () => {
  const ctx = await setupTest();
  const result = await ctx.connection.executeQuery(CompiledQuery.raw('SELECT ? AS value', [7]));

  expect(result).toStrictEqual({ rows: [{ value: 7 }] });
});

test('it answers a write with the rows it changed and the last inserted row id', async () => {
  const ctx = await setupTest();

  ctx.sqlite.run('CREATE TABLE notes (title TEXT NOT NULL)');
  ctx.sqlite.run("INSERT INTO notes (title) VALUES ('first')");

  const result = await ctx.connection.executeQuery(
    CompiledQuery.raw('INSERT INTO notes (title) VALUES (?)', ['second']),
  );

  expect(result).toStrictEqual({ rows: [], numAffectedRows: 1n, insertId: 2n });
});

test('it refuses a streaming query', async () => {
  const ctx = await setupTest();

  expect(() => ctx.connection.streamQuery(CompiledQuery.raw('SELECT 1'), 1)).toThrowWithMessage(
    Error,
    /does not support streaming queries/u,
  );
});

test('it waits for the caller that holds the connection before it finishes destroying', async () => {
  const ctx = await setupTest();

  const destroyed = ctx.driver.destroy();

  // An immediate fires only after every queued promise callback has run, so
  // a destroy still pending here waits on the holder and nothing else.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  const statusWhileHeld = Bun.peek.status(destroyed);

  await ctx.driver.releaseConnection();

  await destroyed;

  expect(statusWhileHeld).toBe('pending');
});

test('it leaves the handle open when the driver is destroyed', async () => {
  const ctx = await setupTest();

  await ctx.driver.releaseConnection();
  await ctx.driver.destroy();

  expect(ctx.sqlite.query('SELECT 1 AS value').get()).toStrictEqual({ value: 1 });
});
