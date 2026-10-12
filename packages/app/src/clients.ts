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

// Where the command's lines and its exit code go, and how it exits: the
// console and the process by default.
interface ClientsIO {
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly exit: (code: number) => void;
}

const PROCESS_IO: ClientsIO = {
  print: (line) => {
    console.log(line);
  },
  printError: (line) => {
    console.error(line);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exit: (code) => {
    process.exit(code);
  },
};

/**
 * Runs `atc clients` or `atc-gateway clients`: lists the clients that may
 * connect to the MCP HTTP server, adds one, or removes one along with every
 * token and consent it holds. It opens the authorization server's database
 * directly, so it works whether or not the server is running. A refused
 * add exits 1 at once, and a refused remove sets exit code 1.
 */
export async function runClients(
  action: ClientsAction,
  target: ClientsTarget,
  io: ClientsIO = PROCESS_IO,
): Promise<void> {
  if (action.kind === 'add') {
    const refused = action.redirectURIs.find((uri) => !isAllowedRedirectURI(uri));

    if (action.redirectURIs.length === 0 || refused !== undefined) {
      const message =
        refused === undefined
          ? `${target.command} add: give at least one --redirect-uri`
          : `${target.command} add: '${refused}' is not a redirect URI atc accepts; use https, or http on a loopback host, with no fragment`;

      io.printError(message);
      io.exit(1);

      return;
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

      io.print(`Added ${name}. Its client ID is ${created.clientID}`);

      return;
    }

    if (action.kind === 'remove') {
      const removed = await removeClient(store.db, action.clientID);

      if (!removed) {
        io.printError(`${target.command} remove: no client has the ID '${action.clientID}'`);
        io.setExitCode(1);

        return;
      }

      io.print(`Removed client ${action.clientID} and revoked every grant it held`);

      return;
    }

    const clients = await collectClients(store.db);

    if (clients.length === 0) {
      io.print(`No clients. Add one with: ${target.command} add <name> --redirect-uri <uri>`);

      return;
    }

    for (const client of clients) {
      io.print(`${client.clientID}  ${client.name}  ${client.redirectURIs.join(' ')}`);
    }
  } finally {
    await store.close();
  }
}
