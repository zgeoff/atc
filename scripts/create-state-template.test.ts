import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createStateStore } from '@atc/store';
import { registerTestCleanup, runCommand, setupTempDir } from '@atc/test-utils';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-state-template-');

  return { directory: temporaryDirectory.path };
}

test('it writes a database whose migration ledger matches a fresh store', async () => {
  const ctx = setupTest();
  const templatePath = join(ctx.directory, 'template.db');
  const freshPath = join(ctx.directory, 'fresh.db');

  await runCommand([
    process.execPath,
    join(import.meta.dir, 'create-state-template.ts'),
    templatePath,
  ]);

  const fresh = await createStateStore(freshPath);

  const stopFresh = registerTestCleanup(() => fresh.stop());

  await stopFresh();

  const templateDB = new Database(templatePath, { readonly: true });

  registerTestCleanup(() => {
    templateDB.close();
  });

  const freshDB = new Database(freshPath, { readonly: true });

  registerTestCleanup(() => {
    freshDB.close();
  });

  expect(templateDB.query('SELECT name FROM kysely_migration ORDER BY name').all()).toStrictEqual(
    freshDB.query('SELECT name FROM kysely_migration ORDER BY name').all(),
  );
});

test('it writes a database the store opens without running a migration', async () => {
  const ctx = setupTest();
  const templatePath = join(ctx.directory, 'template.db');

  await runCommand([
    process.execPath,
    join(import.meta.dir, 'create-state-template.ts'),
    templatePath,
  ]);

  const before = new Database(templatePath, { readonly: true });

  const closeBefore = registerTestCleanup(() => {
    before.close();
  });

  const ledgerBefore = before.query('SELECT name, timestamp FROM kysely_migration').all();

  closeBefore();

  const store = await createStateStore(templatePath);

  await registerTestCleanup(() => store.stop())();

  const after = new Database(templatePath, { readonly: true });

  registerTestCleanup(() => {
    after.close();
  });

  expect(after.query('SELECT name, timestamp FROM kysely_migration').all()).toStrictEqual(
    ledgerBefore,
  );
});

test.each([
  ['a second path', ['first.db', 'second.db']],
  ['an option', ['--force', 'template.db']],
])('it refuses a run with %s and writes no database', async (_label, args) => {
  const ctx = setupTest();

  const refused = await runCommand(
    [process.execPath, join(import.meta.dir, 'create-state-template.ts'), ...args],
    { cwd: ctx.directory },
  );

  expect({ exitCode: refused.exitCode, stderr: refused.stderr }).toStrictEqual({
    exitCode: 2,
    stderr: 'usage: bun scripts/create-state-template.ts <path>\n',
  });

  expect(readdirSync(ctx.directory)).toStrictEqual([]);
});

test('it refuses a run without a path', async () => {
  const refused = await runCommand([
    process.execPath,
    join(import.meta.dir, 'create-state-template.ts'),
  ]);

  expect({ exitCode: refused.exitCode, stderr: refused.stderr }).toStrictEqual({
    exitCode: 2,
    stderr: 'usage: bun scripts/create-state-template.ts <path>\n',
  });
});
