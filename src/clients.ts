import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { collectClients } from './mcp/collect-clients';
import { isAllowedRedirectURI } from './mcp/is-allowed-redirect-uri';
import { openMCPAuth } from './mcp/open-mcp-auth';
import { removeClient } from './mcp/remove-client';
import { normalizeClientName } from './shared/normalize-client-name';

type ClientsAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'add'; readonly name: string; readonly redirectURIs: readonly string[] }
  | { readonly kind: 'remove'; readonly clientID: string };

// The authorization server's database, and the command that prefixes every
// message, such as `atc clients`.
interface ClientsTarget {
  readonly dbPath: string;
  readonly command: string;
}

/**
 * Runs `atc clients` or `atc-gateway clients`: lists the clients that may
 * connect to the MCP HTTP server, adds one, or removes one along with every
 * token and consent it holds. It opens the authorization server's database
 * directly, so it works whether or not the server is running.
 */
export async function runClients(action: ClientsAction, target: ClientsTarget): Promise<void> {
  if (action.kind === 'add') {
    const refused = action.redirectURIs.find((uri) => !isAllowedRedirectURI(uri));

    if (action.redirectURIs.length === 0 || refused !== undefined) {
      const message =
        refused === undefined
          ? `${target.command} add: give at least one --redirect-uri`
          : `${target.command} add: '${refused}' is not a redirect URI atc accepts; use https, or http on a loopback host, with no fragment`;

      console.error(message);
      process.exit(1);
    }
  }

  mkdirSync(dirname(target.dbPath), { recursive: true });

  const store = await openMCPAuth({ dbPath: target.dbPath, origin: null });

  try {
    if (action.kind === 'add') {
      const name = normalizeClientName(action.name);

      const created = await store.auth.api.createFixedClient({
        body: { name, redirectURIs: [...action.redirectURIs] },
      });

      console.log(`Added ${name}. Its client ID is ${created.clientID}`);

      return;
    }

    if (action.kind === 'remove') {
      const removed = await removeClient(store.db, action.clientID);

      if (!removed) {
        console.error(`${target.command} remove: no client has the ID '${action.clientID}'`);

        process.exitCode = 1;

        return;
      }

      console.log(`Removed client ${action.clientID} and revoked every grant it held`);

      return;
    }

    const clients = await collectClients(store.db);

    if (clients.length === 0) {
      console.log(`No clients. Add one with: ${target.command} add <name> --redirect-uri <uri>`);

      return;
    }

    for (const client of clients) {
      console.log(`${client.clientID}  ${client.name}  ${client.redirectURIs.join(' ')}`);
    }
  } finally {
    await store.close();
  }
}
