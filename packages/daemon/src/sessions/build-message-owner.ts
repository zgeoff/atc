import type { MessageOwner } from '@atc/store';
import type { Session } from './session';

export function buildMessageOwner(s: Session): MessageOwner {
  return {
    atcID: s.id,
    ...(s.agentSessionID === undefined ? {} : { agentSessionID: s.agentSessionID }),
  };
}
