import { expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { openMCPAuthDatabase } from './open-mcp-auth-database';

// A temp directory for the database, opened in a folder that does not exist yet.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-mcp-auth-database-');
  const path = join(temporaryDirectory.path, 'state', 'mcp-auth.db');
  const sqlite = openMCPAuthDatabase(path);

  registerTestCleanup(() => {
    sqlite.close();
  });

  return { path, sqlite };
}

test('it opens the database with foreign keys enforced', () => {
  const ctx = setupTest();

  expect(ctx.sqlite.query('pragma foreign_keys').get()).toStrictEqual({ foreign_keys: 1 });
});

test('it opens the database to wait for another process lock before failing', () => {
  const ctx = setupTest();

  expect(ctx.sqlite.query('pragma busy_timeout').get()).toStrictEqual({ timeout: 5000 });
});

test('it creates the file so only its owner may read or write it', () => {
  const ctx = setupTest();

  expect(statSync(ctx.path).mode & 0o777).toBe(0o600);
});
