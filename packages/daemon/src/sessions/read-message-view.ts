import type { StateStore } from '@atc/store';
import type { MessageID } from '@atcx/contract';
import type { SessionManager } from './create-session-manager';
import type { MessageView } from './types';

interface MessageViewDeps {
  readonly manager: Pick<SessionManager, 'sessions'>;
  readonly store: Pick<StateStore, 'readMessageByID' | 'readTurnSiblings'>;
}

export async function readMessageView(
  deps: MessageViewDeps,
  messageID: MessageID,
): Promise<MessageView | null> {
  const record = await deps.store.readMessageByID(messageID);

  if (record === null) {
    return null;
  }

  const owner =
    deps.manager.sessions.find((x) => x.id === record.atcID) ??
    deps.manager.sessions.find(
      (x) => record.agentSessionID !== undefined && x.agentSessionID === record.agentSessionID,
    );

  return {
    session: owner?.id ?? record.atcID,
    record,
    answeredWith: await deps.store.readTurnSiblings(record),
  };
}
