import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mcpAuthDBFile } from '@atc/config';
import { collectGrants } from './mcp/collect-grants';
import { openMCPAuth } from './mcp/open-mcp-auth';
import { revokeGrant } from './mcp/revoke-grant';
import { openMCPAuthDatabase } from './open-mcp-auth-database';

// Where the command's lines and its exit code go: the console and the
// process by default.
interface GrantsIO {
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly setExitCode: (code: number) => void;
}

const PROCESS_IO: GrantsIO = {
  print: (line) => {
    console.log(line);
  },
  printError: (line) => {
    console.error(line);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export async function runGrants(
  revoke: string | null,
  dbPath: string = mcpAuthDBFile,
  io: GrantsIO = PROCESS_IO,
): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });

  const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

  try {
    if (revoke !== null) {
      const revoked = await revokeGrant(store.db, revoke);

      if (!revoked) {
        io.printError(`atc grants: no grant has the ID '${revoke}'`);
        io.setExitCode(1);

        return;
      }

      io.print(`Revoked grant ${revoke}`);

      return;
    }

    const grants = await collectGrants(store.db);

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
