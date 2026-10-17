import { resolve } from 'node:path';
import { expandHome, isHomeRelative } from '@atc/core';

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
