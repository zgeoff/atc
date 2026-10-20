import type { SessionID } from '@atc/core';
import type { MessageSender } from '@atc/protocol/wire';
import type { MessageCaller } from './message-caller';

// The name a message from the owner holds.
const OWNER_NAME = 'owner';

export function buildMessageSender(
  caller: MessageCaller,
  sessions: readonly { readonly id: SessionID; readonly name: string }[],
): MessageSender {
  if (caller.kind === 'connector') {
    return { kind: 'connector', client: caller.client, name: caller.name };
  }

  if (caller.kind === 'session') {
    const name = sessions.find((session) => session.id === caller.session)?.name ?? caller.session;

    return { kind: 'session', session: caller.session, name };
  }

  if (caller.kind === 'local') {
    return { kind: 'local', name: caller.name };
  }

  return { kind: 'owner', name: OWNER_NAME };
}
