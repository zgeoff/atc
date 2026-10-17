import type { AgentSessionID, SessionID } from '@atc/core';
import { truncateDetail } from '@atc/core';
import type { MessageRecord, TrailEntry } from '@atc/store';

export function buildNoticeTrailEntry(
  senderSession: SessionID,
  agentSessionID: AgentSessionID | undefined,
  record: MessageRecord,
  kind: 'notice-queued' | 'notice-delivered',
): TrailEntry {
  const at =
    kind === 'notice-queued'
      ? (record.noticeQueuedAt ?? record.sentAt)
      : (record.noticeDeliveredAt ?? record.sentAt);

  return {
    at,

    // addressed to the sender, so the sender's own feed holds it
    atcID: senderSession,
    agentSessionID: agentSessionID ?? null,
    kind,
    message: record.id,
    detail: truncateDetail(record.answer ?? record.unansweredReason ?? ''),
  };
}
