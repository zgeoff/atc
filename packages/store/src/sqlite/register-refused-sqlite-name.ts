import { lstatSync, readlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

// The file names no SQLite open in this process may reach, lowercased, since
// a case-insensitive filesystem opens the same file under either case.
const refusedNames = new Set<string>();

// Refuses every later open of a SQLite file with this name in this process,
// through a symlink too, until the returned release runs.
export function registerRefusedSQLiteName(name: string): () => void {
  const key = name.toLowerCase();

  refusedNames.add(key);

  return () => {
    refusedNames.delete(key);
  };
}

export function requireOpenableSQLitePath(path: string): void {
  const refused = collectLinkNames(path).find((name) => refusedNames.has(name.toLowerCase()));

  if (refused !== undefined) {
    throw Object.assign(
      new Error(`atc: this process never opens ${refused}, so it refuses ${path}`),
      { code: 'sqlite_refused' },
    );
  }
}

// The most symlinks the kernel follows before it fails with ELOOP.
const MAX_LINK_HOPS = 40;

// The file name of the path and of each symlink target it leads to, a missing
// target included, since SQLite creates the file a dangling link names.
function collectLinkNames(path: string): string[] {
  const names = [basename(path)];
  let current = path;

  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const target = findLinkTarget(current);

    if (target === undefined) {
      break;
    }

    current = resolve(dirname(current), target);

    names.push(basename(current));
  }

  return names;
}

// Undefined for a path that is no symlink, and for one this process cannot
// read, which the SQLite open then fails to reach as well.
function findLinkTarget(path: string): string | undefined {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });

    return stats?.isSymbolicLink() === true ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}
