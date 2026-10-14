import type { AgentSessionID } from '@atc/core/agent-session-id';
import type { SessionID } from '@atc/core/session-id';
import { truncateDetail } from '@atc/core/truncate-detail';
import type { MessageRecord } from '@atc/store/message-record';
import type { TrailEntry } from '@atc/store/trail-entry';

/**
 * The trail entry for one change of a message's answer notice: queued for
 * the sender session, or taken by its tap. It is addressed to the sender
 * session and its agent session id, so the sender's own feed holds it, and
 * stamped with the change's own time. The detail previews the answer, else
 * the reason the message went unanswered.
 */
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
    atcID: senderSession,
    agentSessionID: agentSessionID ?? null,
    kind,
    message: record.id,
    detail: truncateDetail(record.answer ?? record.unansweredReason ?? ''),
  };
}
