import { toAgentSessionID } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';

export function buildHeartbeatEvent(sessionID: string | undefined): AdapterEvent {
  return {
    kind: 'heartbeat',
    ...(sessionID === undefined ? {} : { agentSessionID: toAgentSessionID(sessionID) }),
  };
}
