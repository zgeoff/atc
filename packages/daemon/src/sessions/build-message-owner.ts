import type { MessageOwner } from '@atc/store';
import type { Session } from './session';

/**
 * The owner a session's messages are stored under: its atc id, and its
 * agent session id when it has one.
 */
export function buildMessageOwner(s: Session): MessageOwner {
  return {
    atcID: s.id,
    ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
  };
}
