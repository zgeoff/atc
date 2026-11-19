import type { LogRecord } from '@logtape/logtape';

export function formatLogLine(record: LogRecord): string {
  return `${record.message.map((part) => (typeof part === 'string' ? part : String(part))).join('')}\n`;
}
