import { MCP_TOOLS } from '@atc/mcp';

// The tools that a token with only the read scope may call, by name.
export function collectReadTools(): string[] {
  return MCP_TOOLS.filter((tool) => tool.scope === 'read').map((tool) => tool.name);
}
