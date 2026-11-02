import { posix } from 'node:path';

export function isPathWithin(child: string, parent: string): boolean {
  const relative = posix.relative(parent, child);

  return relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative);
}
