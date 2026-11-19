import { isHomeRelative } from './is-home-relative';

// only a path prefix makes typed input a path to complete and resolve, so a
// name with a slash in it, such as a project under a root, still filters the
// listed directories.
export function isPathInput(input: string): boolean {
  return input.startsWith('/') || isHomeRelative(input) || isRelativePathInput(input);
}

function isRelativePathInput(input: string): boolean {
  return input === '.' || input === '..' || input.startsWith('./') || input.startsWith('../');
}
