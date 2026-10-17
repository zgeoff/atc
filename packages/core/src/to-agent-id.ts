import type { AgentID } from './agent-id';

// missing and empty values read as Claude, so a fleet written before the agent
// column restores as Claude. An unregistered id passes through so the session
// can be shown and refused, never quietly run as Claude.
export function toAgentID(raw: unknown): AgentID {
  return typeof raw === 'string' && raw !== '' ? raw : 'claude';
}
