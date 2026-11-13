import type { Database } from 'bun:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSQLite } from '@atc/store/sqlite';

export function openMCPAuthDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });

  // The file holds token hashes and sessions, so only its owner may read it.
  // SQLite gives the WAL and shared-memory files the main file's mode, so the
  // mode is set before SQLite opens it.
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);

  // a write waits for another process's lock, since the commands and a running
  // server share the file; a revoke's cascade needs foreign keys
  return openSQLite(path, { busyTimeoutMs: 5000, foreignKeys: true });
}
