import { systemClock } from '@atc/core';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { openATCAuthAdmin } from '../auth/open-atc-auth-admin';
import { openTestAuthDatabase } from './open-test-auth-database';

// An admin over the authorization database at `dbPath`, which the test opener opens with the
// pragmas the app's opener sets. The database and the admin close when the test finishes.
export async function openTestAuthAdmin(dbPath: string) {
  const sqlite = openTestAuthDatabase(dbPath);

  registerTestCleanup(() => {
    sqlite.close();
  });

  const admin = await openATCAuthAdmin(sqlite, systemClock);

  registerTestCleanup(() => admin.close());

  return { admin };
}
