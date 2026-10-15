import { resolve } from 'node:path';
import { expandHome, isHomeRelative } from '@atc/core';

/**
 * Where the picker looks a typed path up: `~` and `~/…` under the home
 * directory, `.`, `..`, and `./…` under the client's working directory, and
 * an absolute path as written. Anything else is a filter over the known
 * list, not a path, and resolves to null.
 */
export function resolvePathInput(input: string, cwd: string, home: string): string | null {
  if (isHomeRelative(input)) {
    return resolve(expandHome(input, home));
  }

  if (input.startsWith('/') || isRelativePathInput(input)) {
    return resolve(cwd, input);
  }

  return null;
}

function isRelativePathInput(input: string): boolean {
  return input === '.' || input === '..' || input.startsWith('./') || input.startsWith('../');
}
