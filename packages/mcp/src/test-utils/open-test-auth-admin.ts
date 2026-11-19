import { systemClock } from '@atc/core';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { openATCAuthAdmin } from '../auth/open-atc-auth-admin';
import { openTestAuthDatabase } from './open-test-auth-database';

export async function openTestAuthAdmin(dbPath: string) {
  const sqlite = openTestAuthDatabase(dbPath);

  registerTestCleanup(() => {
    sqlite.close();
  });

  const admin = await openATCAuthAdmin(sqlite, systemClock);

  registerTestCleanup(() => admin.close());

  return { admin };
}
