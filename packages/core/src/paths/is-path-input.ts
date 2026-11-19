import { isHomeRelative } from './is-home-relative';

// A slash alone does not make input a path: a name such as a project under a root
// contains one and must still filter the listed directories.
export function isPathInput(input: string): boolean {
  return input.startsWith('/') || isHomeRelative(input) || isRelativePathInput(input);
}

function isRelativePathInput(input: string): boolean {
  return input === '.' || input === '..' || input.startsWith('./') || input.startsWith('../');
}
