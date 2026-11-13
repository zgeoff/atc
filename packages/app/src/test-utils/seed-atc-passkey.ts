import type { Database } from 'bun:sqlite';

export interface ATCPasskeyRow {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

// atc keeps its passkeys in its own table, so a test writes a row with the
// times the passkeys command prints back.
export function seedATCPasskey(sqlite: Database, row: ATCPasskeyRow): void {
  sqlite.run(
    'insert into "atc_passkey" (id, public_key, counter, transports, created_at, last_used_at) values (?, ?, ?, ?, ?, ?)',
    [row.id, 'public-key', 0, '[]', row.createdAt, row.lastUsedAt ?? null],
  );
}
