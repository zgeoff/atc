import { z } from 'zod';
import type { MessageID } from '../shared/message-id';
import { toMessageID } from '../shared/to-message-id';

interface TurnAnswer {
  readonly kind: 'answered';

  // Every message the turn answered, recorded together.
  readonly messages: readonly MessageID[];
  readonly answer: string;

  // The turn whose final reply the answer is; null from a reporter that
  // sends none.
  readonly turn: string | null;
}

export interface SentNote {
  readonly kind: 'note';
  readonly label: string;
  readonly text: string;
}

export type Note = TurnAnswer | SentNote;

// Optional, so a note from an older bridge still parses; a missing, empty,
// or wrong-typed turn reads as unknown.
const TURN_SCHEMA = z.preprocess(
  (v) => (typeof v === 'string' && v !== '' ? v : undefined),
  z.string().optional(),
);

const MESSAGE_IDS_SCHEMA = z.array(z.string().min(1)).min(1).optional();

const REPORT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('answered'),

      // One message, or every message one turn answered.
      message: z.string().min(1).optional(),
      messages: MESSAGE_IDS_SCHEMA,
      answer: z.string(),
      turn: TURN_SCHEMA,
    })
    .refine((v) => (v.message === undefined) !== (v.messages === undefined)),
  z.object({ kind: z.literal('note'), label: z.string().min(1).max(64), text: z.string().min(1) }),
]);

/**
 * Parses a Note envelope's payload into the note its kind discriminates,
 * or null when it matches no known kind.
 */
export function parseNote(payload: Readonly<Record<string, unknown>>): Note | null {
  const parsed = REPORT_SCHEMA.safeParse(payload);

  if (!parsed.success) {
    return null;
  }

  if (parsed.data.kind === 'note') {
    return { kind: 'note', label: parsed.data.label, text: parsed.data.text };
  }

  return {
    kind: 'answered',
    messages: (parsed.data.messages ?? [parsed.data.message ?? '']).map((id) => toMessageID(id)),
    answer: parsed.data.answer,
    turn: parsed.data.turn ?? null,
  };
}
