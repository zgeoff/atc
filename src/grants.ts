import { mkdirSync } from 'node:fs';
import { collectGrants } from './mcp/collect-grants';
import { openMCPAuth } from './mcp/open-mcp-auth';
import { revokeGrant } from './mcp/revoke-grant';
import { mcpAuthDBFile, stateDir } from './shared/config';

/**
 * Runs `atc grants`: lists the grants clients of `atc mcp --http` hold, or
 * revokes one. A revoked grant's tokens stop working at once, and its client
 * has to go through approval again. It opens the authorization server's
 * database directly, so it works whether or not the server is running.
 */
export async function runGrants(revoke: string | null): Promise<void> {
  mkdirSync(stateDir, { recursive: true });

  const store = await openMCPAuth({ dbPath: mcpAuthDBFile, origin: null });

  try {
    if (revoke !== null) {
      const revoked = await revokeGrant(store.db, revoke);

      if (!revoked) {
        console.error(`atc grants: no grant has the ID '${revoke}'`);

        process.exitCode = 1;

        return;
      }

      console.log(`Revoked grant ${revoke}`);

      return;
    }

    const grants = await collectGrants(store.db);

    if (grants.length === 0) {
      console.log('No grants.');

      return;
    }

    for (const grant of grants) {
      console.log(
        `${grant.grantID}  ${grant.clientName}  ${grant.scopes.join(',')}  last used ${grant.lastUsedAt ?? 'never'}`,
      );
    }
  } finally {
    await store.close();
  }
}
