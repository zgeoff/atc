import { truncateDetail } from '@atc/core';
import type { MessageRecord, MessageStatus, TrailEntry } from '@atc/store';
import type { AgentSessionID, SessionID } from '@atcx/contract';

export function buildMessageTrailEntry(
  sessionID: SessionID,
  agentSessionID: AgentSessionID | undefined,
  record: MessageRecord,
): TrailEntry {
  const base = {
    at: pickStatusTime(record),
    atcID: sessionID,
    agentSessionID: agentSessionID ?? record.agentSessionID ?? null,
    message: record.id,
  };

  if (record.status === 'answered') {
    const answer = record.answer ?? record.text;

    return { ...base, kind: 'message-answered', detail: truncateDetail(answer), text: answer };
  }

  return { ...base, kind: pickMessageKind(record.status), detail: truncateDetail(record.text) };
}

function pickStatusTime(record: MessageRecord): number {
  if (record.status === 'answered') {
    return record.answeredAt ?? record.sentAt;
  }

  if (record.status === 'unanswered') {
    return record.unansweredAt ?? record.sentAt;
  }

  if (record.status === 'delivered') {
    return record.deliveredAt ?? record.sentAt;
  }

  return record.sentAt;
}

function pickMessageKind(
  status: Exclude<MessageStatus, 'answered'>,
): 'message-queued' | 'message-delivered' | 'message-unanswered' {
  if (status === 'unanswered') {
    return 'message-unanswered';
  }

  if (status === 'delivered') {
    return 'message-delivered';
  }

  return 'message-queued';
}
