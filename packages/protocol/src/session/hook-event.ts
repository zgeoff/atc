import type { AgentID } from '@atc/core';
import type { SessionID } from '@atcx/contract';

export interface HookEvent {
  atcId: SessionID;
  agent?: AgentID;
  event: string;
  payload: unknown;
}
