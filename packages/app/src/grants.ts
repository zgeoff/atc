import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mcpAuthDBFile } from '@atc/config';
import { systemClock } from '@atc/core';
import { openMCPAuth, readGrantViews, revokeGrant } from '@atc/mcp';
import { openMCPAuthDatabase } from './open-mcp-auth-database';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';

export async function runGrants(
  revoke: string | null,
  dbPath: string = mcpAuthDBFile,
  io: Pick<ProcessIO, 'print' | 'printError' | 'setExitCode'> = PROCESS_IO,
): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });

  const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

  try {
    if (revoke !== null) {
      const revoked = await revokeGrant(store.db, revoke, systemClock.now());

      if (!revoked) {
        io.printError(`atc grants: no grant has the ID '${revoke}'`);
        io.setExitCode(1);

        return;
      }

      io.print(`Revoked grant ${revoke}`);

      return;
    }

    const grants = await readGrantViews(store.db);

    if (grants.length === 0) {
      io.print('No grants.');

      return;
    }

    for (const grant of grants) {
      io.print(
        `${grant.grantID}  ${grant.clientName}  ${grant.scopes.join(',')}  last used ${grant.lastUsedAt ?? 'never'}`,
      );
    }
  } finally {
    await store.close();
  }
}
