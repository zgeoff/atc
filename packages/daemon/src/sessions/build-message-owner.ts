import type { MessageOwner } from '@atc/store';
import type { Session } from './session';

export function buildMessageOwner(session: Session): MessageOwner {
  return {
    atcID: session.id,
    ...(session.agentSessionID === undefined ? {} : { agentSessionID: session.agentSessionID }),
  };
}
