import type { AgentID } from './agent-id';

/**
 * Missing and empty values become Claude so a fleet written before the agent
 * column still restores as Claude. Any other string is returned as it stands,
 * registered or not: an id whose adapter is gone must reach the caller intact
 * so the session can be shown and refused, never quietly run as Claude.
 */
export function toAgentID(raw: unknown): AgentID {
  return typeof raw === 'string' && raw !== '' ? raw : 'claude';
}
