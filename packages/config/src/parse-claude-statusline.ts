import { buildOptionalString } from '@atc/core/build-optional-string';
import { isRecord } from '@atc/core/is-record';
import { z } from 'zod';

/**
 * The part of a person's Claude settings that atc's own statusline
 * chains: the statusline command Claude runs, and the padding Claude puts
 * around its output. Either is absent when the settings set none.
 */
export interface ClaudeStatusLine {
  readonly command?: string;
  readonly padding?: number;
}

// Only the two fields atc reads; any other field of the settings, and a
// field of another type, is left out.
const PADDING_SCHEMA = z.preprocess(
  (v) => (typeof v === 'number' ? v : undefined),
  z.number().optional(),
);

const STATUS_LINE_SCHEMA = z.object({ command: buildOptionalString(), padding: PADDING_SCHEMA });

const SETTINGS_SCHEMA = z.object({
  statusLine: z.preprocess((v) => (isRecord(v) ? v : undefined), STATUS_LINE_SCHEMA.optional()),
});

/**
 * Reads the statusline of a Claude settings file's text. Text that is not
 * a settings object reads as no statusline, so a broken settings file never
 * breaks the session atc instruments.
 */
export function parseClaudeStatusLine(text: string): ClaudeStatusLine {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }

  const parsed = SETTINGS_SCHEMA.safeParse(json);
  const statusLine = parsed.success ? parsed.data.statusLine : undefined;

  return {
    ...(statusLine?.command === undefined ? {} : { command: statusLine.command }),
    ...(statusLine?.padding === undefined ? {} : { padding: statusLine.padding }),
  };
}
