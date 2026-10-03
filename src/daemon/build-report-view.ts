import { encodeCursor } from '../protocol/encode-cursor';
import type { StoredReport } from '../store/state-store';
import type { SessionDescriptor } from './sessions';

/**
 * One report as `report.get` returns it: the cursor of its event, when it
 * arrived, the session that sent it and that session's name, its label, its
 * text, and whether that text is whole.
 */
export interface ReportView {
  readonly report: string;
  readonly at: number;
  readonly session: string;
  readonly name: string | null;
  readonly label: string;
  readonly text: string;
  readonly complete: boolean;
}

export function buildReportView(
  stored: StoredReport,
  sessions: readonly SessionDescriptor[],
): ReportView {
  // A row written before atc session ids stayed stable across restores
  // carries an earlier atc id, so the agent session id links it.
  const live =
    (stored.agentSessionID === null
      ? undefined
      : sessions.find((s) => s.agentSessionID === stored.agentSessionID)) ??
    sessions.find((s) => s.id === stored.atcID);

  return {
    report: encodeCursor({ kind: 'events', id: stored.id }),
    at: stored.at,
    session: live?.id ?? stored.atcID,
    name: live?.name ?? null,
    label: stored.label,
    text: stored.text,
    complete: stored.complete,
  };
}
