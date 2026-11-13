import { mcpAuthDBFile } from '@atc/config';
import type { GrantID } from '@atc/mcp';
import { toTagged } from '@zgeoff/std';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';
import { withMCPAuthAdmin } from './with-mcp-auth-admin';

export async function runGrants(
  revoke: string | null,
  dbPath: string = mcpAuthDBFile,
  io: Pick<ProcessIO, 'print' | 'printError' | 'setExitCode'> = PROCESS_IO,
): Promise<void> {
  await withMCPAuthAdmin(dbPath, async (admin) => {
    if (revoke !== null) {
      const revoked = await admin.grants.revoke(toTagged<GrantID>(revoke));

      if (!revoked) {
        io.printError(`atc grants: no grant has the ID '${revoke}'`);
        io.setExitCode(1);

        return;
      }

      io.print(`Revoked grant ${revoke}`);

      return;
    }

    const grants = await admin.grants.list();

    if (grants.length === 0) {
      io.print('No grants.');

      return;
    }

    for (const grant of grants) {
      io.print(
        `${grant.grantID}  ${grant.clientName}  ${grant.scopes.join(',')}  last used ${grant.lastUsedAt ?? 'never'}`,
      );
    }
  });
}
