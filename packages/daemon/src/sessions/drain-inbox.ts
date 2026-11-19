import { PROTOCOL_V } from '@atc/protocol/wire';
import type { MessageOwner, MessageRecord } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import type { TapClient } from '../types';
import type { TapGeneration, TapRegistry } from './create-tap-registry';

export interface InboxSource {
  readonly taps: TapRegistry<TapClient>;
  readonly findLinkedOwner: (sessionID: SessionID) => MessageOwner | null;
  readonly readPendingMessages: (owner: MessageOwner) => Promise<MessageRecord[]>;
  readonly readPendingNotices: (senderSession: SessionID) => Promise<MessageRecord[]>;
}

export async function drainInbox(sessionID: SessionID, source: InboxSource): Promise<void> {
  const linkedOwner = source.findLinkedOwner(sessionID);

  // Find the tap before the read. A tap another attach makes during the read must get nothing
  // from it.
  const tap = source.taps.findTap(sessionID);

  if (linkedOwner === null || tap === null) {
    return;
  }

  // A tap a principal holds takes only messages sent to this atc id, because another session
  // that shares the agent session id may not be allowed to see the rest.
  const owner = tap.linked ? linkedOwner : { atcID: linkedOwner.atcID };

  try {
    // Nothing is sent before this read finishes, so the tap's ok reaches the client first.
    const pending = await source.readPendingMessages(owner);

    for (const record of pending) {
      if (sendInboxMessage(sessionID, record, tap, source.taps)) {
        return;
      }
    }

    if (!tap.notices) {
      return;
    }

    const notices = await source.readPendingNotices(sessionID);

    for (const record of notices) {
      if (sendInboxNotice(sessionID, record, tap, source.taps)) {
        return;
      }
    }
  } catch {}
}

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
    version: PROTOCOL_V,
    ev: 'InboxMessage',
    sessionID,
    message: record.id,
    from: record.from,
    ...(record.sender === undefined ? {} : { sender: record.sender }),
    text: record.text,
    sentAt: record.sentAt,
  });

  return true;
}

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
    version: PROTOCOL_V,
    ev: 'InboxNotice',
    sessionID,
    message: record.id,
    from: record.atcID,
    status: record.status,
    ...(record.answer === undefined ? {} : { answer: record.answer }),
    ...(record.unansweredReason === undefined ? {} : { reason: record.unansweredReason }),
    at: record.noticeQueuedAt ?? record.sentAt,
  });

  return true;
}
