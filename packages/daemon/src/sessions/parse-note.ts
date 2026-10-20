import type { MessageID } from '@atc/core';
import { toMessageID } from '@atc/core';
import { z } from 'zod';

interface TurnAnswer {
  readonly kind: 'answered';

  // Every message the turn answered, recorded together.
  readonly messages: readonly MessageID[];
  readonly answer: string;

  // The turn whose final reply the answer is; null from a reporter that
  // sends none.
  readonly turn: string | null;
}

interface TurnUnanswered {
  readonly kind: 'unanswered';

  // Every message the turn carried and ended without answering.
  readonly messages: readonly MessageID[];

  // One word for why: interrupted, error, refusal, or not_started.
  readonly reason: string;

  // The turn that ended; null when the reporter sends none.
  readonly turn: string | null;
}

export interface SentNote {
  readonly kind: 'note';
  readonly label: string;
  readonly text: string;
}

export type Note = TurnAnswer | TurnUnanswered | SentNote;

// Optional, so a note from an older bridge still parses; a missing, empty,
// or wrong-typed turn reads as unknown.
const TURN_SCHEMA = z.preprocess(
  (value) => (typeof value === 'string' && value !== '' ? value : undefined),
  z.string().optional(),
);

const REQUIRED_MESSAGE_IDS_SCHEMA = z.array(z.string().min(1)).min(1);
const MESSAGE_IDS_SCHEMA = REQUIRED_MESSAGE_IDS_SCHEMA.optional();

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
    .refine((report) => (report.message === undefined) !== (report.messages === undefined)),
  z.object({
    kind: z.literal('unanswered'),
    messages: REQUIRED_MESSAGE_IDS_SCHEMA,
    reason: z.string().min(1).max(64),
    turn: TURN_SCHEMA,
  }),
  z.object({ kind: z.literal('note'), label: z.string().min(1).max(64), text: z.string().min(1) }),
]);

export function parseNote(payload: Readonly<Record<string, unknown>>): Note | null {
  const parsed = REPORT_SCHEMA.safeParse(payload);

  if (!parsed.success) {
    return null;
  }

  if (parsed.data.kind === 'note') {
    return { kind: 'note', label: parsed.data.label, text: parsed.data.text };
  }

  if (parsed.data.kind === 'unanswered') {
    return {
      kind: 'unanswered',
      messages: parsed.data.messages.map((id) => toMessageID(id)),
      reason: parsed.data.reason,
      turn: parsed.data.turn ?? null,
    };
  }

  return {
    kind: 'answered',
    messages: (parsed.data.messages ?? [parsed.data.message ?? '']).map((id) => toMessageID(id)),
    answer: parsed.data.answer,
    turn: parsed.data.turn ?? null,
  };
}
