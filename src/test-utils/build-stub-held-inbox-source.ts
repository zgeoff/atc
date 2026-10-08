import type { TapClient } from '../daemon/daemon-context';
import type { InboxSource } from '../daemon/drain-inbox';
import { TapRegistry } from '../daemon/tap-registry';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { SessionID } from '../shared/session-id';
import type { MessageRecord } from '../store/message-record';

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
