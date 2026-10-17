import type { NameUpdate } from '@atc/plugin-api';
import { z } from 'zod';

// The two transcript lines a name comes from: a custom title that /rename
// writes, and a summary that Claude writes on its own.
const NAME_LINE_SCHEMA = z.discriminatedUnion('type', [
  z.object({ type: z.literal('custom-title'), customTitle: z.string() }),
  z.object({ type: z.literal('summary'), summary: z.string() }),
]);

export async function loadClaudeName(
  source: string,
  namedBy: 'user' | 'auto' | 'agent',
): Promise<NameUpdate | null> {
  let text: string;

  try {
    // the transcript can run to many megabytes, so grep picks the two line types out of it
    const proc = Bun.spawn(['grep', '-E', '"type":"(custom-title|summary)"', source], {
      stdout: 'pipe',
      stderr: 'ignore',
    });

    text = await new Response(proc.stdout).text();
  } catch {
    return null;
  }

  let title = '';
  let summary = '';

  for (const line of text.split('\n')) {
    const parsed = NAME_LINE_SCHEMA.safeParse(tryParseJSON(line));

    if (parsed.success && parsed.data.type === 'custom-title') {
      title = parsed.data.customTitle;
    }

    if (parsed.success && parsed.data.type === 'summary') {
      summary = parsed.data.summary;
    }
  }

  if (title !== '') {
    return { name: title, namedBy: 'agent' };
  }

  if (namedBy !== 'user' && summary !== '') {
    return { name: summary };
  }

  return null;
}

function tryParseJSON(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
