import { Database } from 'bun:sqlite';
import type { BindingDatabase } from '../key-binding/create-gateway-store';

export function openTestBindingDatabase(path: string): BindingDatabase {
  const db = new Database(path, { create: true, strict: true });

  db.run('PRAGMA journal_mode = WAL;');

  return db;
}
