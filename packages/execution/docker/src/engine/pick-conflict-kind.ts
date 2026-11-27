import { z } from 'zod';

export type ConflictKind = 'removal-in-progress' | 'volume-in-use' | 'other';

const CONFLICT_SCHEMA = z.object({ message: z.string() });

export function pickConflictKind(body: string): ConflictKind {
  const parsed = CONFLICT_SCHEMA.safeParse(parseJSON(body));

  if (!parsed.success) {
    return 'other';
  }

  const message = parsed.data.message;

  if (/^removal of container \S+ is already in progress$/u.test(message)) {
    return 'removal-in-progress';
  }

  return /: volume is in use\b/u.test(message) ? 'volume-in-use' : 'other';
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
