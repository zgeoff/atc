import { parseJSONStrings } from '@atc/core';

export function parseWithheldEnv(stored: string | null): string[] | null {
  return stored === null ? [] : parseJSONStrings(stored);
}
