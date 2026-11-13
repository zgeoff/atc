import { MCPAuthError } from '@atc/mcp';
import type { MCPAuthAdmin, OAuthClientID } from '@atc/mcp';
import { P, match } from 'ts-pattern';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';
import { withMCPAuthAdmin } from './with-mcp-auth-admin';

export type ClientsAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'add'; readonly name: string; readonly redirectURIs: readonly string[] }

  // `client` is a client ID, or a name that exactly one client has.
  | { readonly kind: 'remove'; readonly client: string };

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
      const resolved = await resolveClientID(admin, action.client);

      if (resolved.kind === 'none') {
        io.printError(`${target.command} remove: no client has the ID or name '${action.client}'`);
        io.setExitCode(1);

        return;
      }

      if (resolved.kind === 'many') {
        io.printError(
          `${target.command} remove: ${resolved.clientIDs.length} clients have the name '${action.client}', so give the ID of the one to remove: ${resolved.clientIDs.join(', ')}`,
        );

        io.setExitCode(1);

        return;
      }

      // Another command may remove the client between the lookup and here.
      try {
        await admin.clients.remove(resolved.clientID);
      } catch (error) {
        if (!(error instanceof MCPAuthError) || error.code !== 'not-found') {
          throw error;
        }

        io.printError(`${target.command} remove: no client has the ID '${resolved.clientID}'`);
        io.setExitCode(1);

        return;
      }

      io.print(`Removed client ${resolved.clientID} and revoked every grant it held`);

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

type ResolvedClient =
  | { readonly kind: 'one'; readonly clientID: OAuthClientID }
  | { readonly kind: 'many'; readonly clientIDs: readonly OAuthClientID[] }
  | { readonly kind: 'none' };

// An ID wins over a name, so a name never hides the client whose ID it is.
async function resolveClientID(admin: MCPAuthAdmin, client: string): Promise<ResolvedClient> {
  const clients = await admin.clients.list();

  const byID = clients.find((listed) => listed.clientID === client);

  if (byID !== undefined) {
    return { kind: 'one', clientID: byID.clientID };
  }

  const byName = await readClientsByName(admin, client);

  return match(byName)
    .returnType<ResolvedClient>()
    .with([], () => ({ kind: 'none' }))
    .with([{ clientID: P.string }], ([only]) => ({ kind: 'one', clientID: only.clientID }))
    .otherwise((many) => ({ kind: 'many', clientIDs: many.map((listed) => listed.clientID) }));
}

// A name that cleans to nothing names no client.
async function readClientsByName(admin: MCPAuthAdmin, name: string) {
  try {
    return await admin.clients.readByName(name);
  } catch (error) {
    if (error instanceof MCPAuthError && error.code === 'invalid-client-name') {
      return [];
    }

    throw error;
  }
}
