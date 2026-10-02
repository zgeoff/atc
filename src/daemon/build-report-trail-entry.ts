import { truncateDetail } from '../agents/truncate-detail';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { SessionID } from '../shared/session-id';
import type { TrailEntry } from '../store/trail-entry';
import type { NoteReport } from './parse-report';

/**
 * The trail entry for one note a session reported, carrying its label and a
 * preview of its text.
 */
export function buildReportTrailEntry(
  sessionID: SessionID,
  agentSessionID: AgentSessionID | undefined,
  report: Readonly<NoteReport>,
  reportedAt: number,
): TrailEntry {
  return {
    at: reportedAt,
    atcID: sessionID,
    agentSessionID: agentSessionID ?? null,
    kind: 'report',
    label: report.label,
    detail: truncateDetail(report.text),
  };
}
