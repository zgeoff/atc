import { resolve } from 'node:path';

/**
 * Where the picker looks a typed path up: `~` and `~/…` under the home
 * directory, `.`, `..`, and `./…` under the client's working directory, and
 * an absolute path as written. Anything else is a filter over the known
 * list, not a path, and resolves to null.
 */
export function resolvePathInput(input: string, cwd: string, home: string): string | null {
  if (input === '~' || input.startsWith('~/')) {
    return resolve(home, input.slice(2));
  }

  if (input.startsWith('/') || isRelativePathInput(input)) {
    return resolve(cwd, input);
  }

  return null;
}

function isRelativePathInput(input: string): boolean {
  return input === '.' || input === '..' || input.startsWith('./') || input.startsWith('../');
}
