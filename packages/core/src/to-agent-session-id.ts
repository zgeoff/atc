import type { AgentSessionID } from './agent-session-id';

/**
 * Trusts a string as an agent-issued session id. This is the one point in
 * the codebase where a plain string becomes an `AgentSessionID`, and it adds
 * no runtime check: the caller asserts the string is the id an agent CLI
 * issued for its own resume mechanism.
 */
export function toAgentSessionID(id: string): AgentSessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the one point where a string is trusted as an AgentSessionID
  return id as AgentSessionID;
}
