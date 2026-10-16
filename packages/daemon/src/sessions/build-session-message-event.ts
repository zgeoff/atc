import type { SessionID } from '@atc/core';
import { truncateDetail } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { MessageRecord } from '@atc/store';

/**
 * The `SessionMessage` event for one message status change, addressed by
 * the atc session id the message currently belongs to. The event carries
 * short previews of the text and answer, never the full content, so a
 * broadcast stays small; `message.get` returns the full message. Delivery,
 * answer, and unanswered fields appear only once they are set.
 */
export function buildSessionMessageEvent(sessionID: SessionID, record: MessageRecord): EventMsg {
  return {
    v: PROTOCOL_V,
    ev: 'SessionMessage',
    s: sessionID,
    message: record.id,
    status: record.status,
    from: record.from,
    ...(record.sender === undefined ? {} : { sender: record.sender }),
    textPreview: truncateDetail(record.text),
    sentAt: record.sentAt,
    ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
    ...(record.answeredAt === undefined ? {} : { answeredAt: record.answeredAt }),
    ...(record.answer === undefined ? {} : { answerPreview: truncateDetail(record.answer) }),
    ...(record.unansweredAt === undefined ? {} : { unansweredAt: record.unansweredAt }),
    ...(record.unansweredReason === undefined ? {} : { unansweredReason: record.unansweredReason }),
  };
}
