import type { MCPToolAnnotations } from './types';

export const TOOL_ANNOTATIONS = {
  readOnly: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  additive: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },

  // A tool that starts an agent or puts text in front of one reaches past atc: the agent acts on
  // what it reads, outside atc's control.
  agentFacing: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  agentFacingDestructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
} as const satisfies Readonly<Record<string, MCPToolAnnotations>>;
