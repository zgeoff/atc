import { Database } from 'bun:sqlite';
import { buildMockSessionOwnerRow } from './build-mock-session-owner-row';
import type { SessionOwnerRow } from './build-mock-session-owner-row';

export interface SessionOwnerSeedDeps {
  readonly dbPath: string;
}

export function seedLaterEpochSessionOwner(
  deps: SessionOwnerSeedDeps,
  input: Partial<SessionOwnerRow> = {},
): SessionOwnerRow {
  const row = { ...buildMockSessionOwnerRow(input), owner_epoch: 2 };

  const db = new Database(deps.dbPath);

  try {
    // An owner row from a later ownership epoch: this build writes every
    // owner row at the first epoch, so none of its code makes one.
    db.run(
      'INSERT OR REPLACE INTO session_owner (session_id, daemon_id, owner_epoch, updated_at) VALUES (?, ?, ?, ?)',
      [row.session_id, row.daemon_id, row.owner_epoch, row.updated_at],
    );
  } finally {
    db.close();
  }

  return row;
}
