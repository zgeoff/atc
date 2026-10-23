import type { AdapterEvent } from '@atc/protocol';
import { toAgentSessionID } from '@atcx/contract';

export function buildHeartbeatEvent(sessionID: string | undefined): AdapterEvent {
  return {
    kind: 'heartbeat',
    ...(sessionID === undefined ? {} : { agentSessionID: toAgentSessionID(sessionID) }),
  };
}
