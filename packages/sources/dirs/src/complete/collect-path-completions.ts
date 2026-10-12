import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolvePathInput } from './resolve-path-input';

/**
 * Shell-style completion of a typed path: the child directories of the
 * typed parent whose names start with the last segment, and the typed
 * directory itself first when it exists, so Enter takes it. A trailing
 * slash lists every child. Hidden directories show only when the segment
 * starts with a dot. Input that is not a path completes to nothing.
 */
export function collectPathCompletions(input: string, cwd: string, home: string): string[] {
  const target = resolvePathInput(input, cwd, home);

  if (target === null) {
    return [];
  }

  const listsChildren = input.endsWith('/') || input === '~' || input === '.' || input === '..';
  const parent = listsChildren ? target : dirname(target);
  const partial = listsChildren ? '' : basename(target);

  const children = collectChildDirs(parent).filter((child) => {
    const name = basename(child);

    return (
      name.toLowerCase().startsWith(partial.toLowerCase()) &&
      (partial.startsWith('.') || !name.startsWith('.'))
    );
  });

  if (listsChildren && isDirectory(target)) {
    return [target, ...children.filter((child) => child !== target)];
  }

  return [
    ...children.filter((child) => child === target),
    ...children.filter((child) => child !== target),
  ];
}

function collectChildDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
      .toSorted();
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
