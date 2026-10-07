import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { collectGrants } from './mcp/collect-grants';
import { openMCPAuth } from './mcp/open-mcp-auth';
import { revokeGrant } from './mcp/revoke-grant';
import { mcpAuthDBFile } from './shared/config';

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

/**
 * Runs `atc grants`: lists the grants clients of `atc mcp --http` hold, or
 * revokes one. A revoked grant's tokens stop working at once, and its client
 * has to go through approval again. It opens the authorization server's
 * database at `dbPath` directly, so it works whether or not the server is
 * running. Revoking a grant that does not exist sets exit code 1.
 */
export async function runGrants(
  revoke: string | null,
  dbPath: string = mcpAuthDBFile,
  io: GrantsIO = PROCESS_IO,
): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });

  const store = await openMCPAuth({ dbPath, origin: null });

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
