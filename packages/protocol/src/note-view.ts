import { z } from 'zod';

/**
 * A note a session sent, as `note.get` answers it: its events cursor, when
 * it was sent, the session and its name then, the label, the text, and
 * whether the text is whole or was cut.
 */
export const NOTE_VIEW_SCHEMA = z.object({
  note: z.string(),
  at: z.number(),
  session: z.string(),
  name: z.string().nullable(),
  label: z.string(),
  text: z.string(),
  complete: z.boolean(),
});

export type NoteView = z.output<typeof NOTE_VIEW_SCHEMA>;
