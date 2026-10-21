import { Database } from 'bun:sqlite';
import type { BindingDatabase } from '../gateway-store';

// The binding database as the gateway's entry opens it: named parameters
// without their prefix, and WAL, so a second store reads the first one's writes.
export function openTestBindingDatabase(path: string): BindingDatabase {
  const db = new Database(path, { create: true, strict: true });

  db.run('PRAGMA journal_mode = WAL;');

  return db;
}
