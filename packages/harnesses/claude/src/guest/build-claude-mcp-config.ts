import type { ClaudeMCPServer } from '@atc/config';
import { BROKER_PLACEHOLDER } from '@atc/core';

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
