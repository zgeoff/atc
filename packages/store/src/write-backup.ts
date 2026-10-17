import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join as joinPath } from 'node:path';
import { DaemonError } from '@atc/protocol/wire';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { StateStoreSchema } from './sqlite/state-store-schema';

// VACUUM INTO reads in one transaction, so the copy never holds half of a
// write; the flushed copy is renamed over the path, which then holds its
// old content or a whole copy. Resolves to the copy's size in bytes.
export async function writeBackup(
  db: Kysely<StateStoreSchema>,
  dbPath: string,
  path: string,
): Promise<number> {
  // The database file resolves in full, since SQLite opens the file a
  // link points to and names its log files after that path.
  const live = realpathSync(dbPath);

  if ([live, `${live}-wal`, `${live}-shm`, `${live}-journal`].includes(resolveRealFilePath(path))) {
    // Replacing a file SQLite holds open loses every later write.
    throw new DaemonError(
      'bad_args',
      `${path} is the daemon's own database or one of its log files; back up to another path`,
    );
  }

  // A fresh directory beside `path` that only this user can enter, so the
  // copy never exists where another user can read it, and SQLite writes it
  // to a path that does not exist yet.
  const stagingDir = mkdtempSync(joinPath(dirname(path), `.${basename(path)}.partial-`));
  const staging = joinPath(stagingDir, 'backup.db');

  try {
    await sql`VACUUM INTO ${staging}`.execute(db);

    chmodSync(staging, 0o600);

    const fd = openSync(staging, 'r');

    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(staging, path);

    // The rename lives in the directory, so the directory is flushed too:
    // without it, a power loss can drop the new entry after the command
    // reported success.
    const dirFD = openSync(dirname(path), 'r');

    try {
      fsyncSync(dirFD);
    } finally {
      closeSync(dirFD);
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  return statSync(path).size;
}

// The path of a file with its directory's symlinks resolved, so two spellings
// of one location compare equal. A directory that does not exist keeps the
// path as given.
function resolveRealFilePath(path: string): string {
  try {
    return joinPath(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}
