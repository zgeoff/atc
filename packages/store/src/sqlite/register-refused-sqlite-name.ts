import { existsSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';

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
  const names = [basename(path)];

  if (existsSync(path)) {
    names.push(basename(realpathSync(path)));
  }

  const refused = names.find((name) => refusedNames.has(name.toLowerCase()));

  if (refused !== undefined) {
    throw Object.assign(
      new Error(`atc: this process never opens ${refused}, so it refuses ${path}`),
      { code: 'sqlite_refused' },
    );
  }
}
