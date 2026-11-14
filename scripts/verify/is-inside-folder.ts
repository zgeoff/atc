import { relative } from 'node:path';

export function isInsideFolder(folder: string, path: string): boolean {
  const inside = relative(folder, path);

  return inside !== '' && !inside.startsWith('..') && !inside.startsWith('/');
}
