import { MCPAuthError } from '@atc/mcp';
import { match } from 'ts-pattern';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';
import { withMCPAuthAdmin } from './with-mcp-auth-admin';

export type ClientsAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'add'; readonly name: string; readonly redirectURIs: readonly string[] }
  | { readonly kind: 'remove'; readonly clientID: string };

// The authorization server's database, and the command that prefixes every
// message, such as `atc clients`.
interface ClientsTarget {
  readonly dbPath: string;
  readonly command: string;
}

export async function runClients(
  action: ClientsAction,
  target: ClientsTarget,
  io: Pick<ProcessIO, 'print' | 'printError' | 'setExitCode' | 'exit'> = PROCESS_IO,
): Promise<void> {
  if (action.kind === 'add' && action.redirectURIs.length === 0) {
    io.printError(`${target.command} add: give at least one --redirect-uri`);
    io.exit(1);

    return;
  }

  await withMCPAuthAdmin(target.dbPath, async (admin) => {
    if (action.kind === 'add') {
      try {
        const created = await admin.clients.add(action.name, action.redirectURIs);

        io.print(`Added ${created.name}. Its client ID is ${created.clientID}`);
      } catch (error) {
        if (!(error instanceof MCPAuthError)) {
          throw error;
        }

        io.printError(`${target.command} add: ${formatAddError(error)}`);
        io.setExitCode(1);
      }

      return;
    }

    if (action.kind === 'remove') {
      // The CLI names a client by its ID, and the package removes one by name.
      const clients = await admin.clients.list();

      const client = clients.find((listed) => listed.clientID === action.clientID);

      if (client === undefined) {
        io.printError(`${target.command} remove: no client has the ID '${action.clientID}'`);
        io.setExitCode(1);

        return;
      }

      await admin.clients.remove(client.name);

      io.print(`Removed client ${action.clientID} and revoked every grant it held`);

      return;
    }

    const clients = await admin.clients.list();

    if (clients.length === 0) {
      io.print(`No clients. Add one with: ${target.command} add <name> --redirect-uri <uri>`);

      return;
    }

    for (const client of clients) {
      io.print(`${client.clientID}  ${client.name}  ${client.redirectURIs.join(' ')}`);
    }
  });
}

function formatAddError(error: MCPAuthError): string {
  return match(error.code)
    .with(
      'invalid-redirect-uri',
      () =>
        'a redirect URI is not one atc accepts; use https, or http on a loopback host, with no fragment',
    )
    .with('conflict', () => 'a client already has that name')
    .with('invalid-client-name', () => 'give the client a name')
    .with('not-found', 'invalid-setup', () => error.message)
    .exhaustive();
}
