import { isRecord } from '@atc/core';

const SECURITY_PREFIX = 'atc security ';

export function readSecurityEvent(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line.slice(SECURITY_PREFIX.length));

  if (!isRecord(parsed)) {
    throw new TypeError('security line is not a JSON object');
  }

  return parsed;
}
