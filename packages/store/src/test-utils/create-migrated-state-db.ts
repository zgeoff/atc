import { copyFileSync } from 'node:fs';
import { seedDaemonID } from './seed-daemon-id';

// The test script migrates one state database per run, so a copy skips the
// migration ladder, which takes half a second per open on a loaded host.
export function createMigratedStateDB(dbPath: string): void {
  const template = process.env['ATC_TEST_STATE_TEMPLATE'];

  if (template === undefined) {
    throw new Error('ATC_TEST_STATE_TEMPLATE is unset; run the tests through `bun run test`');
  }

  copyFileSync(template, dbPath);

  // The migration draws the daemon id at random, so each copy draws its own,
  // as two real databases would.
  seedDaemonID({ dbPath });
}
