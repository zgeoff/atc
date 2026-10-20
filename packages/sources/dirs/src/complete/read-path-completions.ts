import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolvePathInput } from './resolve-path-input';

export function readPathCompletions(input: string, cwd: string, home: string): string[] {
  const target = resolvePathInput(input, cwd, home);

  if (target === null) {
    return [];
  }

  const listsChildren = input.endsWith('/') || input === '~' || input === '.' || input === '..';
  const parent = listsChildren ? target : dirname(target);
  const partial = listsChildren ? '' : basename(target);

  const children = readChildDirs(parent).filter((child) => {
    const name = basename(child);

    return (
      name.toLowerCase().startsWith(partial.toLowerCase()) &&
      (partial.startsWith('.') || !name.startsWith('.'))
    );
  });

  if (listsChildren && probeDirectory(target)) {
    return [target, ...children.filter((child) => child !== target)];
  }

  return [
    ...children.filter((child) => child === target),
    ...children.filter((child) => child !== target),
  ];
}

function readChildDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
      .toSorted();
  } catch {
    return [];
  }
}

function probeDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
