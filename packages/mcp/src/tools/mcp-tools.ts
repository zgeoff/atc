import { FLEET_TOOLS } from './fleet-tools';
import { MESSAGE_TOOLS } from './message-tools';
import { SESSION_LIFECYCLE_TOOLS } from './session-lifecycle-tools';
import { SESSION_READ_TOOLS } from './session-read-tools';
import { SESSION_SPAWN_TOOLS } from './session-spawn-tools';
import { TERMINAL_TOOLS } from './terminal-tools';
import type { MCPToolDefinition } from './types';

export const MCP_TOOLS: readonly MCPToolDefinition[] = [
  ...SESSION_SPAWN_TOOLS,
  ...TERMINAL_TOOLS,
  ...SESSION_LIFECYCLE_TOOLS,
  ...FLEET_TOOLS,
  ...SESSION_READ_TOOLS,
  ...MESSAGE_TOOLS,
];
