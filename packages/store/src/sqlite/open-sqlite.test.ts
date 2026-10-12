import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { openSQLite } from './open-sqlite';

function setupTest() {
  const tmp = setupTempDir('atc-open-sqlite-');

  return { dbPath: join(tmp.dir, 'test.db') };
}

test('it creates the file and opens it in write-ahead-log mode', () => {
  const ctx = setupTest();
  const sqlite = openSQLite(ctx.dbPath);

  onTestFinished(() => {
    sqlite.close();
  });

  expect(existsSync(ctx.dbPath)).toBe(true);
  expect(sqlite.query('PRAGMA journal_mode').get()).toStrictEqual({ journal_mode: 'wal' });
});

test('it leaves the busy timeout and foreign keys at their defaults when the options set neither', () => {
  const ctx = setupTest();
  const sqlite = openSQLite(ctx.dbPath);

  onTestFinished(() => {
    sqlite.close();
  });

  expect(sqlite.query('PRAGMA busy_timeout').get()).toStrictEqual({ timeout: 0 });
  expect(sqlite.query('PRAGMA foreign_keys').get()).toStrictEqual({ foreign_keys: 0 });
});

test('it sets the busy timeout and foreign keys the options ask for', () => {
  const ctx = setupTest();
  const sqlite = openSQLite(ctx.dbPath, { busyTimeoutMs: 5000, foreignKeys: true });

  onTestFinished(() => {
    sqlite.close();
  });

  expect(sqlite.query('PRAGMA busy_timeout').get()).toStrictEqual({ timeout: 5000 });
  expect(sqlite.query('PRAGMA foreign_keys').get()).toStrictEqual({ foreign_keys: 1 });
});

test('it binds a named parameter without its prefix when the options ask for strict mode', () => {
  const ctx = setupTest();
  const sqlite = openSQLite(ctx.dbPath, { strict: true });

  onTestFinished(() => {
    sqlite.close();
  });

  expect(sqlite.query('SELECT $value AS value').get({ value: 7 })).toStrictEqual({ value: 7 });
});
