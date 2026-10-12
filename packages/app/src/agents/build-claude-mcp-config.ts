import type { ClaudeMCPServer } from '../shared/collect-claude-auth';

/**
 * The MCP config file that gives a session each server over HTTP with the
 * broker's placeholder as a bearer credential in the server's header, so
 * impd's broker swaps in the credential it holds for the server's host and
 * the session never holds it.
 */
export function buildClaudeMCPConfig(servers: readonly ClaudeMCPServer[]): {
  readonly mcpServers: Readonly<Record<string, unknown>>;
} {
  return {
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        {
          type: 'http',
          url: server.url,
          headers: { [server.header]: `Bearer ${BROKER_PLACEHOLDER}` },
        },
      ]),
    ),
  };
}

// The value impd's broker replaces with the credential on the host's side.
const BROKER_PLACEHOLDER = 'imp-broker-placeholder';
