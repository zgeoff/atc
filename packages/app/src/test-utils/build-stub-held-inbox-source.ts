import type { AgentSessionID } from '@atc/core/agent-session-id';
import type { SessionID } from '@atc/core/session-id';
import type { MessageRecord } from '@atc/store/message-record';
import type { TapClient } from '../daemon/daemon-context';
import type { InboxSource } from '../daemon/drain-inbox';
import { TapRegistry } from '../daemon/tap-registry';

/**
 * An inbox source over a real, empty tap registry, standing in for the
 * daemon's store. It holds every session under the given agent session id,
 * and its pending-message read waits until the test answers it: `reading`
 * settles once a read starts, `answer` answers the read with the given
 * messages whatever owner it asked for.
 */
export function buildStubHeldInboxSource(agentSessionID: AgentSessionID) {
  const pending = Promise.withResolvers<MessageRecord[]>();
  const reading = Promise.withResolvers<void>();

  const source: InboxSource = {
    taps: new TapRegistry<TapClient>(),
    findLinkedOwner: (sessionID: SessionID) => ({ atcID: sessionID, agentSessionID }),
    collectPendingMessages: () => {
      reading.resolve();

      return pending.promise;
    },
  };

  return {
    source,
    reading: reading.promise,
    answer: (records: readonly MessageRecord[]) => {
      pending.resolve([...records]);
    },
  };
}
