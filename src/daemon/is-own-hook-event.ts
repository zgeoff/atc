import type { AgentID } from '../shared/agent-id';

/**
 * Whether a hook line, judged by the agent it carries, comes from the
 * harness atc started for its session rather than from a harness nested
 * inside it, which inherits the session's environment and so reports under
 * the same session. A line carrying an agent is the session's own when that
 * agent is the session's. A line without one comes from a hook command that
 * carries no agent flag, and stays the session's own until a line carrying
 * the session's agent arrives from the same terminal: from then on the
 * session's own hooks are known to carry it.
 */
export function isOwnHookEvent(
  lineAgent: AgentID | undefined,
  sessionAgent: AgentID,
  hasAgentHookLines: boolean,
): boolean {
  return lineAgent === undefined ? !hasAgentHookLines : lineAgent === sessionAgent;
}
