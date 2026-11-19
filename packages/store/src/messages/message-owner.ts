import type { AgentSessionID, SessionID } from '@atcx/contract';

export interface MessageOwner {
  readonly atcID: SessionID;
  readonly agentSessionID?: AgentSessionID;
}
