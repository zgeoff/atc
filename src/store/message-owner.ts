import type { AgentSessionID } from '../shared/agent-session-id';
import type { SessionID } from '../shared/session-id';

// Which session a message belongs to: the atc id it was sent to, or the
// agent session id that survives a restore's re-minted atc id.
export interface MessageOwner {
  readonly atcID: SessionID;
  readonly agentSessionID?: AgentSessionID;
}
