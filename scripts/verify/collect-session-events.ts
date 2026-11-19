import { z } from 'zod';

const eventLineSchema = z.object({
  ev: z.string(),
  session: z.object({ name: z.string(), state: z.string() }).optional(),
});

export interface SessionEvent {
  readonly ev: string;
  readonly state: string;
}

export function collectSessionEvents(lines: readonly string[], name: string): SessionEvent[] {
  return lines.flatMap((line) => {
    const parsed = eventLineSchema.safeParse(parseJSONLine(line));

    if (!parsed.success || parsed.data.session?.name !== name) {
      return [];
    }

    return [{ ev: parsed.data.ev, state: parsed.data.session.state }];
  });
}

function parseJSONLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
