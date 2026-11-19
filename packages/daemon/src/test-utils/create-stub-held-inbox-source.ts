import type { MessageRecord } from '@atc/store';
import type { AgentSessionID, SessionID } from '@atcx/contract';
import { createTapRegistry } from '../sessions/create-tap-registry';
import type { InboxSource } from '../sessions/drain-inbox';
import type { TapClient } from '../types';

export function createStubHeldInboxSource(
  agentSessionID: AgentSessionID,
  notices: readonly MessageRecord[] = [],
) {
  const pending = Promise.withResolvers<MessageRecord[]>();
  const reading = Promise.withResolvers<void>();

  const source: InboxSource = {
    taps: createTapRegistry<TapClient>(),
    findLinkedOwner: (sessionID: SessionID) => ({ atcID: sessionID, agentSessionID }),
    readPendingMessages: () => {
      reading.resolve();

      return pending.promise;
    },
    readPendingNotices: () => Promise.resolve([...notices]),
  };

  return {
    source,
    reading: reading.promise,
    answer: (records: readonly MessageRecord[]) => {
      pending.resolve([...records]);
    },
  };
}
