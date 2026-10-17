import { parseJSONStrings } from '@atc/core';

// The variable names a workspace withholds, none for a row without a ready
// workspace, or null when the stored list is malformed.
export function parseWithheldEnv(stored: string | null): string[] | null {
  return stored === null ? [] : parseJSONStrings(stored);
}
