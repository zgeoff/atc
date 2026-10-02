import { z } from 'zod';
import type { MessageID } from '../shared/message-id';
import { REPORT_KINDS } from '../shared/report-kinds';
import type { ReportKind } from '../shared/report-kinds';
import { toMessageID } from '../shared/to-message-id';

export interface Report {
  readonly kind: ReportKind;
  readonly message: MessageID;
  readonly answer: string;
}

const REPORT_SCHEMA = z.object({
  kind: z.enum(REPORT_KINDS),
  message: z.string().min(1),
  answer: z.string(),
});

/**
 * Parses a Report envelope's payload into the report its kind discriminates,
 * or null when it matches no known kind.
 */
export function parseReport(payload: Readonly<Record<string, unknown>>): Report | null {
  const parsed = REPORT_SCHEMA.safeParse(payload);

  if (!parsed.success) {
    return null;
  }

  return {
    kind: parsed.data.kind,
    message: toMessageID(parsed.data.message),
    answer: parsed.data.answer,
  };
}
