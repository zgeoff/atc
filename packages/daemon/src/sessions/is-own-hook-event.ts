import type { AgentID } from '@atc/core';

// a nested harness inherits the session's environment and reports under the same session; a line
// without an agent comes from a hook with no agent flag, and counts as the session's own until a
// line carrying the session's agent arrives from the same terminal
export function isOwnHookEvent(
  lineAgent: AgentID | undefined,
  sessionAgent: AgentID,
  hasAgentHookLines: boolean,
): boolean {
  return lineAgent === undefined ? !hasAgentHookLines : lineAgent === sessionAgent;
}
