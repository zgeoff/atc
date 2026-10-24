import { z } from 'zod';
import type { AgentSessionID } from './agent-session-id';

const AGENT_SESSION_ID_SCHEMA = z.string().brand<'AgentSessionID'>();

export function toAgentSessionID(id: string): AgentSessionID {
  return AGENT_SESSION_ID_SCHEMA.parse(id);
}
