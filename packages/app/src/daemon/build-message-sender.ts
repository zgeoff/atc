import type { SessionID } from '@atc/core/session-id';
import type { MessageSender } from '@atc/protocol/message-sender';
import type { MessageCaller } from './message-caller';

// The name a message from the owner holds.
const OWNER_NAME = 'owner';

/**
 * The sender a message from the caller holds: a connector as its client id
 * and name, a session as its atc id and the name the session holds among
 * `sessions` now, or its id when none of them is that session, a local
 * program as the name it gives, and the owner as `owner`.
 */
export function buildMessageSender(
  caller: MessageCaller,
  sessions: readonly { readonly id: SessionID; readonly name: string }[],
): MessageSender {
  if (caller.kind === 'connector') {
    return { kind: 'connector', client: caller.client, name: caller.name };
  }

  if (caller.kind === 'session') {
    const name = sessions.find((s) => s.id === caller.session)?.name ?? caller.session;

    return { kind: 'session', session: caller.session, name };
  }

  if (caller.kind === 'local') {
    return { kind: 'local', name: caller.name };
  }

  return { kind: 'owner', name: OWNER_NAME };
}
