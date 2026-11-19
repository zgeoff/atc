import type { AgentID } from './agent-id';

// Saved fleets can lack an agent value, and those sessions restore as Claude.
// An unknown id is kept as-is so the session is shown and refused, never run as Claude.
export function toAgentID(raw: unknown): AgentID {
  return typeof raw === 'string' && raw !== '' ? raw : 'claude';
}
