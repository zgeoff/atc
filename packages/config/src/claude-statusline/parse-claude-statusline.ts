import { isRecord } from '@atc/core';

/**
 * The part of a person's Claude settings that atc's own statusline
 * chains: the statusline command Claude runs, and the padding Claude puts
 * around its output. Either is absent when the settings set none.
 */
export interface ClaudeStatusLine {
  readonly command?: string;
  readonly padding?: number;
}

/**
 * Reads the statusline of a Claude settings file's text. Text that is not
 * a settings object reads as no statusline, so a broken settings file never
 * breaks the session atc instruments. Only the two fields atc reads come
 * back, and a field of another type is left out. The statusline reporter
 * loads this module at start-up, so it reads the fields by hand rather than
 * through a Zod schema.
 */
export function parseClaudeStatusLine(text: string): ClaudeStatusLine {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }

  const statusLine = isRecord(json) ? json['statusLine'] : undefined;

  if (!isRecord(statusLine)) {
    return {};
  }

  const command = statusLine['command'];
  const padding = statusLine['padding'];

  return {
    ...(typeof command === 'string' ? { command } : {}),
    ...(typeof padding === 'number' ? { padding } : {}),
  };
}
