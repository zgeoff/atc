import type { SessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { MessageOwner, MessageRecord } from '@atc/store';
import type { TapClient } from './daemon-context';
import type { TapGeneration, TapRegistry } from './tap-registry';

/**
 * What a drain reads from: the taps, the owner a linked tap reads messages
 * under (the session's atc id and agent session id, or null for a session
 * the daemon does not hold), the store's pending messages for an owner, and
 * the store's queued answer notices for a sender session.
 */
export interface InboxSource {
  readonly taps: TapRegistry<TapClient>;
  readonly findLinkedOwner: (sessionID: SessionID) => MessageOwner | null;
  readonly collectPendingMessages: (owner: MessageOwner) => Promise<MessageRecord[]>;
  readonly collectPendingNotices: (senderSession: SessionID) => Promise<MessageRecord[]>;
}

/**
 * Hands the session's tap the oldest pending message it has not taken, or,
 * with none left and a tap that takes notices, the oldest queued answer
 * notice of a message the session sent. The backlog is read before
 * anything is sent, so a tap's ok response is always queued ahead of its
 * first message, and one item goes per call: the tap's ack calls it again,
 * so the backlog never outgrows the connection's outbound queue. The drain
 * is bound to the tap it found before the read: a tap another attach made
 * while the read waited gets nothing from it.
 */
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

    if (!tap.notices) {
      return;
    }

    const notices = await source.collectPendingNotices(sessionID);

    for (const record of notices) {
      if (sendInboxNotice(sessionID, record, tap, source.taps)) {
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
    ...(record.sender === undefined ? {} : { sender: record.sender }),
    text: record.text,
    sentAt: record.sentAt,
  });

  return true;
}

// Hands one queued answer notice to the tap the drain was made for, once,
// and reports whether it did. Like a message, the event goes to the tap
// connection alone.
function sendInboxNotice(
  sessionID: SessionID,
  record: MessageRecord,
  tap: TapGeneration,

  taps: TapRegistry<TapClient>,
): boolean {
  if (record.status !== 'answered' && record.status !== 'unanswered') {
    return false;
  }

  const client = taps.claimDelivery(sessionID, record.id, tap.generation, 'notice');

  if (client === null) {
    return false;
  }

  client.sendEvent({
    v: PROTOCOL_V,
    ev: 'InboxNotice',
    s: sessionID,
    message: record.id,
    from: record.atcID,
    status: record.status,
    ...(record.answer === undefined ? {} : { answer: record.answer }),
    ...(record.unansweredReason === undefined ? {} : { reason: record.unansweredReason }),
    at: record.noticeQueuedAt ?? record.sentAt,
  });

  return true;
}
