import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

export interface DaemonIDSeedDeps {
  readonly dbPath: string;
}

export function seedDaemonID(
  deps: DaemonIDSeedDeps,
  input: { readonly daemonID?: string } = {},
): string {
  const daemonID = input.daemonID ?? randomUUID();

  const db = new Database(deps.dbPath);

  try {
    // A copy of the run's migrated template with a daemon id of its own: the
    // migration draws the id only on a database's first open, so no code in
    // the repo draws one for a copy.
    db.run("UPDATE prefs SET value = ? WHERE key = 'daemon_id'", [daemonID]);
  } finally {
    db.close();
  }

  return daemonID;
}
