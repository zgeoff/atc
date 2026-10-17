import { isRecord } from '@atc/core';

export interface ClaudeStatusLine {
  readonly command?: string;
  readonly padding?: number;
}

// the statusline reporter loads this module at start-up, so it reads the
// fields by hand rather than through a schema.
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
