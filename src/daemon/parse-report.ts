import { z } from 'zod';
import type { MessageID } from '../shared/message-id';
import { toMessageID } from '../shared/to-message-id';

interface AnsweredReport {
  readonly kind: 'answered';
  readonly message: MessageID;
  readonly answer: string;

  // The turn whose final reply the answer is; null from a reporter that
  // sends none.
  readonly turn: string | null;
}

export interface NoteReport {
  readonly kind: 'note';
  readonly label: string;
  readonly text: string;
}

export type Report = AnsweredReport | NoteReport;

// Optional, so a report from an older bridge still parses; a missing, empty,
// or wrong-typed turn reads as unknown.
const TURN_SCHEMA = z.preprocess(
  (v) => (typeof v === 'string' && v !== '' ? v : undefined),
  z.string().optional(),
);

const REPORT_SCHEMA = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('answered'),
    message: z.string().min(1),
    answer: z.string(),
    turn: TURN_SCHEMA,
  }),
  z.object({ kind: z.literal('note'), label: z.string().min(1).max(64), text: z.string().min(1) }),
]);

/**
 * Parses a Report envelope's payload into the report its kind discriminates,
 * or null when it matches no known kind.
 */
export function parseReport(payload: Readonly<Record<string, unknown>>): Report | null {
  const parsed = REPORT_SCHEMA.safeParse(payload);

  if (!parsed.success) {
    return null;
  }

  if (parsed.data.kind === 'note') {
    return { kind: 'note', label: parsed.data.label, text: parsed.data.text };
  }

  return {
    kind: 'answered',
    message: toMessageID(parsed.data.message),
    answer: parsed.data.answer,
    turn: parsed.data.turn ?? null,
  };
}
