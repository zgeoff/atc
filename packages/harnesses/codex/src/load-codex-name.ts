import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NameUpdate } from '@atc/plugin-api/agent-adapter';
import { z } from 'zod';

// One line of the session index: a thread's id and its title.
const INDEX_LINE_SCHEMA = z.object({ id: z.string(), thread_name: z.string() });

/**
 * The name the session index in `codexHome` gives the Codex thread
 * `source`, or null when it gives none. The index appends a line each time
 * a title changes, so the last line for the thread wins. The index does not
 * record whether /rename or Codex set a title, so a title never overrides a
 * name a person typed.
 */
export async function loadCodexName(
  codexHome: string,
  source: string,
  namedBy: 'user' | 'auto' | 'agent',
): Promise<NameUpdate | null> {
  if (namedBy === 'user') {
    return null;
  }

  let text: string;

  try {
    text = await readFile(join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return null;
  }

  const names = text
    .split('\n')
    .filter((line) => line.includes(source))
    .flatMap((line) => {
      const parsed = INDEX_LINE_SCHEMA.safeParse(tryParseJSON(line));

      return parsed.success && parsed.data.id === source ? [parsed.data.thread_name] : [];
    });

  const name = names.at(-1);

  return name === undefined || name === '' ? null : { name };
}

function tryParseJSON(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
