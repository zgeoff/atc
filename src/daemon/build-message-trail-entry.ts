import { truncateDetail } from '../agents/truncate-detail';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { SessionID } from '../shared/session-id';
import type { MessageRecord, MessageStatus } from '../store/message-record';
import type { TrailEntry } from '../store/trail-entry';

/**
 * The trail entry for one message status change, addressed like its SessionMessage
 * broadcast. It is stamped with the status's own time and the owning session's agent
 * session id, falling back to the one the message carries, and the detail previews
 * the answer once there is one, else the text.
 */
export function buildMessageTrailEntry(
  sessionID: SessionID,
  agentSessionID: AgentSessionID | undefined,
  record: MessageRecord, // oxlint-disable-line prefer-readonly-parameter-types -- every field is readonly; the branded id has no readonly form to wrap it in
): TrailEntry {
  const previewText = record.status === 'answered' ? (record.answer ?? record.text) : record.text;

  return {
    at: pickStatusTime(record),
    atcID: sessionID,
    agentSessionID: agentSessionID ?? record.agentSessionID ?? null,
    kind: pickMessageKind(record.status),
    message: record.id,
    detail: truncateDetail(previewText),
  };
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- every field is readonly; the branded id has no readonly form to wrap it in
function pickStatusTime(record: MessageRecord): number {
  if (record.status === 'answered') {
    return record.answeredAt ?? record.sentAt;
  }

  if (record.status === 'delivered') {
    return record.deliveredAt ?? record.sentAt;
  }

  return record.sentAt;
}

function pickMessageKind(
  status: MessageStatus,
): 'message-accepted' | 'message-delivered' | 'message-answered' {
  if (status === 'answered') {
    return 'message-answered';
  }

  if (status === 'delivered') {
    return 'message-delivered';
  }

  return 'message-accepted';
}
