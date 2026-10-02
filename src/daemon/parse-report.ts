import { z } from 'zod';
import type { MessageID } from '../shared/message-id';
import { toMessageID } from '../shared/to-message-id';

interface AnsweredReport {
  readonly kind: 'answered';
  readonly message: MessageID;
  readonly answer: string;
}

export interface NoteReport {
  readonly kind: 'note';
  readonly label: string;
  readonly text: string;
}

export type Report = AnsweredReport | NoteReport;

const REPORT_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answered'), message: z.string().min(1), answer: z.string() }),
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
  };
}
