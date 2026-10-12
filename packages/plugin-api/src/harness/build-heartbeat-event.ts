import { toAgentSessionID } from '@atc/core/to-agent-session-id';
import type { AdapterEvent } from '@atc/protocol/adapter-event';

/**
 * The event a hook line means when it means nothing more: a heartbeat,
 * with the agent's own session id when the line held one. Every other
 * event a hook line maps to starts from it.
 */
export function buildHeartbeatEvent(sessionID: string | undefined): AdapterEvent {
  return {
    kind: 'heartbeat',
    ...(sessionID === undefined ? {} : { agentSessionID: toAgentSessionID(sessionID) }),
  };
}
