import type { AgentSessionID } from '@atc/core/agent-session-id';
import type { SessionID } from '@atc/core/session-id';
import { truncateDetail } from '@atc/core/truncate-detail';
import type { MessageRecord, MessageStatus } from '@atc/store/message-record';
import type { TrailEntry } from '@atc/store/trail-entry';

/**
 * The trail entry for one message status change, addressed like its SessionMessage
 * broadcast. It is stamped with the status's own time and the owning session's agent
 * session id, falling back to the one the message carries, and the detail previews
 * the answer once there is one, else the text. An answered entry also holds the
 * whole answer.
 */
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
