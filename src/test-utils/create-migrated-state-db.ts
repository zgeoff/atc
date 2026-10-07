import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { StateStore } from '../store/state-store';

let template: Promise<string> | undefined;

/**
 * Creates a state database at the path that is already at the latest schema,
 * by copying a database the store migrated once per test process. A store
 * opened on the copy finds every migration applied and runs none, so a test
 * that needs a ready store skips the migration ladder. Each copy is a file of
 * its own; every copy holds the same daemon id, minted when the template was
 * migrated. The template sits in the test home, which the test script removes
 * on exit.
 */
export async function createMigratedStateDB(dbPath: string): Promise<void> {
  template ??= createTemplateStateDB();

  const templatePath = await template;

  copyFileSync(templatePath, dbPath);
}

async function createTemplateStateDB(): Promise<string> {
  const home = process.env['ATC_TEST_HOME'];

  if (home === undefined) {
    throw new Error('ATC_TEST_HOME is unset; run the tests through `bun run test`');
  }

  const path = join(home, 'migrated-state.db');

  const store = await StateStore.open(path);

  await store.stop();

  return path;
}
