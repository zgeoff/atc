import type { AgentID } from '@atc/core';

// A nested harness inherits the session's environment and reports under the same session.
// Hooks started without an agent flag emit lines with no agent. Those count as the session's own
// until a line carrying the session's agent arrives from the same terminal.
export function isOwnHookEvent(
  lineAgent: AgentID | undefined,
  sessionAgent: AgentID,
  hasAgentHookLines: boolean,
): boolean {
  return lineAgent === undefined ? !hasAgentHookLines : lineAgent === sessionAgent;
}
