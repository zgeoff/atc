import type { AgentSessionID } from '../shared/agent-session-id';
import type { SessionID } from '../shared/session-id';
import { truncateDetail } from '../shared/truncate-detail';
import type { TrailEntry } from '../store/trail-entry';
import type { NoteReport } from './parse-report';

/**
 * The trail entry for one note a session reported, carrying its label, its
 * text and a preview of it, and the id its reporter gave it, when it gave
 * one.
 */
export function buildReportTrailEntry(
  sessionID: SessionID,
  agentSessionID: AgentSessionID | undefined,
  report: Readonly<NoteReport>,
  reportedAt: number,
  reportID?: string,
): TrailEntry {
  return {
    at: reportedAt,
    atcID: sessionID,
    agentSessionID: agentSessionID ?? null,
    kind: 'report',
    label: report.label,
    detail: truncateDetail(report.text),
    text: report.text,
    ...(reportID === undefined ? {} : { reportID }),
  };
}
