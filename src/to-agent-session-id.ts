import type { AgentSessionID } from './agent-session-id';

/**
 * A literal string as an agent-issued session id. Adapters mint these from a
 * hook payload or a stored fleet row; this stands one in for a fixture that
 * needs an id without either behind it.
 */
export function toAgentSessionID(id: string): AgentSessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- a stand-in for an id an adapter would mint from a payload
  return id as AgentSessionID;
}
