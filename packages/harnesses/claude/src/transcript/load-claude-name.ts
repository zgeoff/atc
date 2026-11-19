import type { HostFiles, NameUpdate } from '@atc/plugin-api';
import { z } from 'zod';

const NAME_LINE_SCHEMA = z.discriminatedUnion('type', [
  z.object({ type: z.literal('custom-title'), customTitle: z.string() }),
  z.object({ type: z.literal('summary'), summary: z.string() }),
]);

export async function loadClaudeName(
  source: string,
  namedBy: 'user' | 'auto' | 'agent',
  files: HostFiles,
): Promise<NameUpdate | null> {
  const lines = await files.readMatchingLines(source, '"type":"(custom-title|summary)"');

  if (lines === null) {
    return null;
  }

  let title = '';
  let summary = '';

  for (const line of lines) {
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
