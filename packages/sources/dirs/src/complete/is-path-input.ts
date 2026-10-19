import { isHomeRelative } from '@atc/core';

// Whether typed input reads as a path: under the home, absolute, or relative
// to a working directory.
export function isPathInput(input: string): boolean {
  return input.startsWith('/') || isHomeRelative(input) || isRelativePathInput(input);
}

function isRelativePathInput(input: string): boolean {
  return input === '.' || input === '..' || input.startsWith('./') || input.startsWith('../');
}
