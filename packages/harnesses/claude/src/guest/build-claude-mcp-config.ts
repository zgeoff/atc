import type { ClaudeMCPServer } from '@atc/config';
import { BROKER_PLACEHOLDER } from '@atc/core';

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
