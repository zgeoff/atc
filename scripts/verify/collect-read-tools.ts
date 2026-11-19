import { MCP_TOOLS } from '@atc/mcp';

export function collectReadTools(): string[] {
  return MCP_TOOLS.filter((tool) => tool.scope === 'read').map((tool) => tool.name);
}
