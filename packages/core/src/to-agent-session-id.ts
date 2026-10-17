import type { AgentSessionID } from './agent-session-id';

export function toAgentSessionID(id: string): AgentSessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the one point where a string is trusted as an AgentSessionID
  return id as AgentSessionID;
}
