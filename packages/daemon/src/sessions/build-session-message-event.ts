import { truncateDetail } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type { MessageRecord } from '@atc/store';
import type { SessionID } from '@atcx/contract';

export function buildSessionMessageEvent(sessionID: SessionID, record: MessageRecord): EventMsg {
  return {
    version: PROTOCOL_V,
    ev: 'SessionMessage',
    sessionID,
    message: record.id,
    status: record.status,
    from: record.from,
    ...(record.sender === undefined ? {} : { sender: record.sender }),

    // previews only, so a broadcast stays small; the full message is fetched on request
    textPreview: truncateDetail(record.text),
    sentAt: record.sentAt,
    ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
    ...(record.answeredAt === undefined ? {} : { answeredAt: record.answeredAt }),
    ...(record.answer === undefined ? {} : { answerPreview: truncateDetail(record.answer) }),
    ...(record.unansweredAt === undefined ? {} : { unansweredAt: record.unansweredAt }),
    ...(record.unansweredReason === undefined ? {} : { unansweredReason: record.unansweredReason }),
  };
}
