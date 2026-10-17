import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { StateStore } from '../state-store';

let template: Promise<string> | undefined;

export async function createMigratedStateDB(dbPath: string): Promise<void> {
  const home = process.env['ATC_TEST_HOME'];

  if (home === undefined) {
    throw new Error('ATC_TEST_HOME is unset; run the tests through `bun run test`');
  }

  template ??= createTemplateStateDB(home);

  const templatePath = await template;

  copyFileSync(templatePath, dbPath);
}

async function createTemplateStateDB(home: string): Promise<string> {
  // One name per process, since parallel test processes share the test home.
  const path = join(home, `migrated-state-${String(process.pid)}.db`);

  const store = await StateStore.open(path);

  await store.stop();

  return path;
}
