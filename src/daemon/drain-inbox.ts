import { PROTOCOL_V } from '../protocol/protocol';
import type { SessionID } from '../shared/session-id';
import type { MessageOwner } from '../store/message-owner';
import type { MessageRecord } from '../store/message-record';
import type { TapClient } from './daemon-context';
import type { TapGeneration, TapRegistry } from './tap-registry';

/**
 * What a drain reads from: the taps, the owner a linked tap reads messages
 * under (the session's atc id and agent session id, or null for a session
 * the daemon does not hold), and the store's pending messages for an owner.
 */
export interface InboxSource {
  readonly taps: TapRegistry<TapClient>;
  readonly findLinkedOwner: (sessionID: SessionID) => MessageOwner | null;
  readonly collectPendingMessages: (owner: MessageOwner) => Promise<MessageRecord[]>;
}

/**
 * Hands the session's tap the oldest pending message it has not taken. The
 * backlog is read before anything is sent, so a tap's ok response is always
 * queued ahead of its first message, and one message goes per call: the
 * tap's ack calls it again, so the backlog never outgrows the connection's
 * outbound queue. The drain is bound to the tap it found before the read: a
 * tap another attach made while the read waited gets nothing from it.
 */
// oxlint-disable-next-line prefer-readonly-parameter-types -- the drain claims deliveries in the tap registry it is given
export async function drainInbox(sessionID: SessionID, source: InboxSource): Promise<void> {
  const linkedOwner = source.findLinkedOwner(sessionID);
  const tap = source.taps.findTap(sessionID);

  if (linkedOwner === null || tap === null) {
    return;
  }

  // A tap a principal holds takes only the messages sent to this atc id:
  // another session that shares the agent session id may be out of its
  // reach.
  const owner = tap.linked ? linkedOwner : { atcID: linkedOwner.atcID };

  try {
    const pending = await source.collectPendingMessages(owner);

    for (const record of pending) {
      if (sendInboxMessage(sessionID, record, tap, source.taps)) {
        return;
      }
    }
  } catch {}
}

// Hands one pending message to the tap the drain was made for, once, and
// reports whether it did. An unlinked tap takes only a message sent to the
// session's own atc id. The event goes to the tap connection alone: it never
// reaches other clients, the events socket, or hooks.
function sendInboxMessage(
  sessionID: SessionID,
  record: MessageRecord,
  tap: TapGeneration,

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a delivery claims the message in the registry
  taps: TapRegistry<TapClient>,
): boolean {
  if (!tap.linked && record.atcID !== sessionID) {
    return false;
  }

  const client = taps.claimDelivery(sessionID, record.id, tap.generation);

  if (client === null) {
    return false;
  }

  client.sendEvent({
    v: PROTOCOL_V,
    ev: 'InboxMessage',
    s: sessionID,
    message: record.id,
    from: record.from,
    text: record.text,
    sentAt: record.sentAt,
  });

  return true;
}
