import { join } from 'node:path';

export interface GatewayStatePaths {
  readonly bindingsDBFile: string;
  readonly mcpAuthDBFile: string;
}

export function buildGatewayStatePaths(stateDir: string): GatewayStatePaths {
  return {
    bindingsDBFile: join(stateDir, 'gateway.db'),
    mcpAuthDBFile: join(stateDir, 'mcp-auth.db'),
  };
}
