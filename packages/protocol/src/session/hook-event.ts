import type { AgentID, SessionID } from '@atc/core';

export interface HookEvent {
  atcId: SessionID;
  agent?: AgentID;
  event: string;
  payload: Record<string, unknown>;
}
