import type { AgentSessionID } from '../shared/agent-session-id';
import type { SessionID } from '../shared/session-id';

// Which session a message belongs to: the atc id it was sent to, or the
// agent session id, which links rows written under an earlier atc id.
export interface MessageOwner {
  readonly atcID: SessionID;
  readonly agentSessionID?: AgentSessionID;
}
