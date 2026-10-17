import type { LogRecord } from '@logtape/logtape';

/**
 * Formats a LogTape record as one plain line of the daemon's stderr: the
 * record's message with each value it carries written as a string, and a
 * newline. A line the caller built in full goes in as the one value of the
 * template `{line}`, so it comes out as it went in.
 */
export function formatLogLine(record: LogRecord): string {
  return `${record.message.map((part) => (typeof part === 'string' ? part : String(part))).join('')}\n`;
}
