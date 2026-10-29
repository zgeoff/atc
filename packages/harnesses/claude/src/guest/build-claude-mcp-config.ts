import type { ClaudeMCPServer } from '@atc/config';
import { BROKER_PLACEHOLDER } from '@atc/core';

// atcArgv starts the atc inside the guest, whose MCP server reaches the daemon
// through the session's bridge socket; null leaves the session without atc.
export function buildClaudeMCPConfig(
  servers: readonly ClaudeMCPServer[],
  atcArgv: readonly string[] | null,
): {
  readonly mcpServers: Readonly<Record<string, unknown>>;
} {
  const [command, ...args] = atcArgv ?? [];

  return {
    mcpServers: {
      ...Object.fromEntries(
        servers.map((server) => [
          server.name,
          {
            type: 'http',
            url: server.url,
            headers: { [server.header]: `Bearer ${BROKER_PLACEHOLDER}` },
          },
        ]),
      ),
      ...(command === undefined ? {} : { atc: { type: 'stdio', command, args: [...args, 'mcp'] } }),
    },
  };
}
