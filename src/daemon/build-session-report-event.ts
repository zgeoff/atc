import { PROTOCOL_V } from '../protocol/protocol';
import type { EventMsg } from '../protocol/protocol';
import type { SessionID } from '../shared/session-id';
import type { NoteReport } from './parse-report';

/**
 * The `SessionReport` event for a note an agent sent mid-turn, addressed by
 * the atc session that sent it. The note's label travels as the event's
 * `kind`.
 */
export function buildSessionReportEvent(
  sessionID: SessionID,
  report: NoteReport,
  reportedAt: number,
): EventMsg {
  return {
    v: PROTOCOL_V,
    ev: 'SessionReport',
    s: sessionID,
    kind: report.label,
    text: report.text,
    reportedAt,
  };
}
