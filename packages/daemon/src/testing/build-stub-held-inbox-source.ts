import type { AgentSessionID, SessionID } from '@atc/core';
import type { MessageRecord } from '@atc/store';
import type { TapClient } from '../daemon-context';
import type { InboxSource } from '../sessions/drain-inbox';
import { TapRegistry } from '../sessions/tap-registry';

export function buildStubHeldInboxSource(
  agentSessionID: AgentSessionID,
  notices: readonly MessageRecord[] = [],
) {
  const pending = Promise.withResolvers<MessageRecord[]>();
  const reading = Promise.withResolvers<void>();

  const source: InboxSource = {
    taps: new TapRegistry<TapClient>(),
    findLinkedOwner: (sessionID: SessionID) => ({ atcID: sessionID, agentSessionID }),
    collectPendingMessages: () => {
      reading.resolve();

      return pending.promise;
    },
    collectPendingNotices: () => Promise.resolve([...notices]),
  };

  return {
    source,
    reading: reading.promise,
    answer: (records: readonly MessageRecord[]) => {
      pending.resolve([...records]);
    },
  };
}
