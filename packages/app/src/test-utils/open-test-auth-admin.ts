import { openATCAuthAdmin, openEventDatabase } from '@atc/mcp';
import { systemClock } from '@zgeoff/std';
import { registerTestCleanup } from '@zgeoff/testing';
import { openMCPAuthDatabase } from '../mcp/open-mcp-auth-database';
import { seedATCPasskey } from './seed-atc-passkey';
import type { ATCPasskeyRow } from './seed-atc-passkey';

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

    events,

    seedPasskey: (row: ATCPasskeyRow): void => {
      seedATCPasskey(sqlite, row);
    },
    countEnrollmentTokens: (): number =>
      sqlite.query('select token_hash from "atc_enrollment_token"').all().length,
  };
}
