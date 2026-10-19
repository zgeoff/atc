import { isRecord } from '@atc/core';

// Whether a line is an oRPC peer message, which carries a string message id;
// a line-protocol message carries a numeric one under another key.
export function isPeerMessage(line: string): boolean {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }

  return isRecord(parsed) && typeof parsed['i'] === 'string';
}
