import { toTagged } from '@zgeoff/std';
import type { AgentSessionID } from './agent-session-id';

export function toAgentSessionID(id: string): AgentSessionID {
  return toTagged<AgentSessionID>(id);
}
