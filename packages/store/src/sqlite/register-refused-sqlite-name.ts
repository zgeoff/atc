import { lstatSync, readlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

// Lowercased, since a case-insensitive filesystem opens the same file under either case.
const refusedNames = new Set<string>();

export function registerRefusedSQLiteName(name: string): () => void {
  const key = name.toLowerCase();

  refusedNames.add(key);

  return () => {
    refusedNames.delete(key);
  };
}

export function requireOpenableSQLitePath(path: string): void {
  const refused = readLinkNames(path).find((name) => refusedNames.has(name.toLowerCase()));

  if (refused !== undefined) {
    throw Object.assign(
      new Error(`atc: this process never opens ${refused}, so it refuses ${path}`),
      { code: 'sqlite_refused' },
    );
  }
}

// The most symlinks the kernel follows before it fails with ELOOP.
const MAX_LINK_HOPS = 40;

// A missing target is included, since SQLite creates the file a dangling link names.
function readLinkNames(path: string): string[] {
  const names = [basename(path)];
  let current = path;

  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    const target = readLinkTarget(current);

    if (target === undefined) {
      break;
    }

    current = resolve(dirname(current), target);

    names.push(basename(current));
  }

  return names;
}

// An unreadable path is not an error here: opening it as a database fails to reach it as well.
function readLinkTarget(path: string): string | undefined {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });

    return stats?.isSymbolicLink() === true ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}
