import type { AgentID } from '../shared/agent-id';
import type { SessionID } from '../shared/session-id';

/**
 * One line a hook reporter sends: the atc session it reports on, the agent
 * whose hook command sent it, the agent's hook event name, and the hook's
 * payload as the agent gave it. The agent is absent on a line from a hook
 * command that carries none.
 */
export interface HookEvent {
  atcId: SessionID;
  agent?: AgentID;
  event: string;
  payload: Record<string, unknown>;
}
