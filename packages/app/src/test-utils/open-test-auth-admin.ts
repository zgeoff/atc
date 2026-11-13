import { systemClock } from '@atc/core';
import { openATCAuthAdmin, openEventDatabase } from '@atc/mcp';
import { registerTestCleanup } from '@atc/test-utils';
import { openMCPAuthDatabase } from '../open-mcp-auth-database';
import { seedATCPasskey } from './seed-atc-passkey';
import type { ATCPasskeyRow } from './seed-atc-passkey';

// The authorization database opened the way the `clients`, `grants` and
// `passkeys` commands open it, closed when the test finishes.
export async function openTestAuthAdmin(dbPath: string) {
  const sqlite = openMCPAuthDatabase(dbPath);

  registerTestCleanup(() => {
    sqlite.close();
  });

  const admin = await openATCAuthAdmin(sqlite, systemClock);

  registerTestCleanup(() => admin.close());

  const events = openEventDatabase(sqlite);

  registerTestCleanup(() => events.destroy());

  return {
    admin,

    // atc's own event tables, beside the package's.
    events,

    seedPasskey: (row: ATCPasskeyRow): void => {
      seedATCPasskey(sqlite, row);
    },
    countEnrollmentTokens: (): number =>
      sqlite.query('select token_hash from "atc_enrollment_token"').all().length,
  };
}
