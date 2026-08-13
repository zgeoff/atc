import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import type { HookEvent } from './hooks';
import { isRecord } from './report';
import type { FleetEntry } from './sessions';

/**
 * Daemon state in one SQLite store: the restorable fleet, the hook-event
 * debug trail, and the spawn-directory history. The statusline contract
 * file (status.json) stays a plain file because reporters inside wrangled
 * sessions read it without speaking to the daemon. An existing fleet.json
 * seeds the fleet table once, so upgrading never loses a restorable fleet.
 */
export class StateStore {
  private readonly db: Database;

  constructor(dbPath: string, legacyFleetPath?: string) {
    this.db = new Database(dbPath, { create: true });

    this.db.run('PRAGMA journal_mode = WAL;');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS fleet (
        claude_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        grp TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        atc_id TEXT NOT NULL,
        event TEXT NOT NULL,
        message TEXT,
        session_id TEXT
      );
      CREATE TABLE IF NOT EXISTS spawn_history (
        cwd TEXT PRIMARY KEY,
        last_spawn INTEGER NOT NULL
      );
    `);

    // Stores created before groups existed lack the column; the create
    // above only applies to fresh databases.
    const fleetColumns = this.db
      .query<{ name: string }, []>('PRAGMA table_info(fleet)')
      .all()
      .map((c) => c.name);

    if (!fleetColumns.includes('grp')) {
      this.db.run('ALTER TABLE fleet ADD COLUMN grp TEXT');
    }

    if (legacyFleetPath !== undefined) {
      this.adoptLegacyFleet(legacyFleetPath);
    }
  }

  loadFleet(): FleetEntry[] {
    const rows = this.db
      .query<{ claude_id: string; name: string; cwd: string; grp: string | null }, []>(
        'SELECT claude_id, name, cwd, grp FROM fleet',
      )
      .all();

    const entries: FleetEntry[] = [];

    for (const row of rows) {
      const entry: FleetEntry =
        row.grp === null
          ? { claudeId: row.claude_id, name: row.name, cwd: row.cwd }
          : { claudeId: row.claude_id, name: row.name, cwd: row.cwd, group: row.grp };

      entries.push(entry);
    }

    return entries;
  }

  writeFleet(entries: readonly FleetEntry[]): void {
    const replace = this.db.transaction((all: readonly FleetEntry[]) => {
      this.db.run('DELETE FROM fleet');

      const insert = this.db.query(
        'INSERT OR REPLACE INTO fleet (claude_id, name, cwd, grp) VALUES (?1, ?2, ?3, ?4)',
      );

      for (const entry of all) {
        insert.run(entry.claudeId, entry.name, entry.cwd, entry.group ?? null);
      }
    });

    replace(entries);
  }

  recordEvent(e: HookEvent): void {
    const rawMessage = e.payload['message'];
    const rawSessionID = e.payload['session_id'];
    const message = typeof rawMessage === 'string' ? rawMessage : null;
    const sessionID = typeof rawSessionID === 'string' ? rawSessionID : null;

    this.db
      .query(
        'INSERT INTO events (ts, atc_id, event, message, session_id) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
      .run(new Date().toISOString(), e.atcId, e.event, message, sessionID);
  }

  recordSpawnDir(cwd: string): void {
    this.db
      .query(
        'INSERT INTO spawn_history (cwd, last_spawn) VALUES (?1, ?2) ON CONFLICT(cwd) DO UPDATE SET last_spawn = ?2',
      )
      .run(cwd, Date.now());
  }

  collectSpawnDirs(): string[] {
    const rows = this.db
      .query<{ cwd: string }, []>('SELECT cwd FROM spawn_history ORDER BY last_spawn DESC')
      .all();

    return rows.map((row) => row.cwd);
  }

  stop(): void {
    this.db.close();
  }

  private adoptLegacyFleet(legacyFleetPath: string): void {
    const count = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fleet').get();

    if (count === null || count.n > 0 || !existsSync(legacyFleetPath)) {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(legacyFleetPath, 'utf8'));

      if (!Array.isArray(parsed)) {
        return;
      }

      const entries = parsed.filter(
        (entry): entry is FleetEntry =>
          isRecord(entry) &&
          typeof entry['name'] === 'string' &&
          typeof entry['cwd'] === 'string' &&
          typeof entry['claudeId'] === 'string',
      );

      this.writeFleet(entries);
    } catch {}
  }
}
