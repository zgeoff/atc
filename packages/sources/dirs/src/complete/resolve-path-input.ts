import { resolve } from 'node:path';
import { expandHome, isHomeRelative, isPathInput } from '@atc/core';

export function resolvePathInput(input: string, cwd: string, home: string): string | null {
  if (isHomeRelative(input)) {
    return resolve(expandHome(input, home));
  }

  return isPathInput(input) ? resolve(cwd, input) : null;
}
