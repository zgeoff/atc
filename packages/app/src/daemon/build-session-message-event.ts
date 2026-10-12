import { PROTOCOL_V } from '../protocol/protocol';
import type { EventMsg } from '../protocol/protocol';
import type { SessionID } from '../shared/session-id';
import { truncateDetail } from '../shared/truncate-detail';
import type { MessageRecord } from '../store/message-record';

/**
 * The `SessionMessage` event for one message status change, addressed by
 * the atc session id the message currently belongs to. The event carries
 * short previews of the text and answer, never the full content, so a
 * broadcast stays small; `message.get` returns the full message. Delivery
 * and answer fields appear only once they are set.
 */
export function buildSessionMessageEvent(sessionID: SessionID, record: MessageRecord): EventMsg {
  return {
    v: PROTOCOL_V,
    ev: 'SessionMessage',
    s: sessionID,
    message: record.id,
    status: record.status,
    from: record.from,
    textPreview: truncateDetail(record.text),
    sentAt: record.sentAt,
    ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
    ...(record.answeredAt === undefined ? {} : { answeredAt: record.answeredAt }),
    ...(record.answer === undefined ? {} : { answerPreview: truncateDetail(record.answer) }),
  };
}
