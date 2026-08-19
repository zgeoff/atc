import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { toAgentKind } from './agent-adapter';
import type { AgentKind } from './agent-adapter';
import type { HookEvent } from './hooks';
import { parseFleetEntry } from './sessions';
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
        agent_session_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_attached INTEGER,
        agent TEXT NOT NULL DEFAULT 'claude'
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
      CREATE TABLE IF NOT EXISTS prefs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Stores created before pinning, attach recency, or agent kind existed
    // lack the columns; the create above only applies to fresh databases.
    const fleetColumns = new Set(
      this.db
        .query<{ name: string }, []>('PRAGMA table_info(fleet)')
        .all()
        .map((c) => c.name),
    );

    // Stores created before the id column was agent-neutral carry it under
    // its Claude-era name.
    if (fleetColumns.has('claude_id')) {
      this.db.run('ALTER TABLE fleet RENAME COLUMN claude_id TO agent_session_id');
    }

    if (!fleetColumns.has('pinned')) {
      this.db.run('ALTER TABLE fleet ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }

    if (!fleetColumns.has('last_attached')) {
      this.db.run('ALTER TABLE fleet ADD COLUMN last_attached INTEGER');
    }

    if (!fleetColumns.has('agent')) {
      this.db.run("ALTER TABLE fleet ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'");
    }

    if (legacyFleetPath !== undefined) {
      this.adoptLegacyFleet(legacyFleetPath);
    }
  }

  loadFleet(): FleetEntry[] {
    const rows = this.db
      .query<
        {
          agent_session_id: string;
          name: string;
          cwd: string;
          pinned: number;
          last_attached: number | null;
          agent: string | null;
        },
        []
      >('SELECT agent_session_id, name, cwd, pinned, last_attached, agent FROM fleet')
      .all();

    const entries: FleetEntry[] = [];

    for (const row of rows) {
      entries.push({
        agentSessionID: row.agent_session_id,
        name: row.name,
        cwd: row.cwd,
        agent: toAgentKind(row.agent),
        ...(row.pinned === 0 ? {} : { pinned: true }),
        ...(row.last_attached === null ? {} : { lastAttachedAt: row.last_attached }),
      });
    }

    return entries;
  }

  // The latest hook-event timestamp per agent session id, from the event
  // trail. Sessions that never reported an event are absent.
  collectFleetRecency(): Map<string, string> {
    const rows = this.db
      .query<{ session_id: string; ts: string }, []>(
        'SELECT session_id, MAX(ts) AS ts FROM events WHERE session_id IS NOT NULL GROUP BY session_id',
      )
      .all();

    return new Map(rows.map((row) => [row.session_id, row.ts]));
  }

  writeFleet(entries: readonly FleetEntry[]): void {
    const replace = this.db.transaction((all: readonly FleetEntry[]) => {
      this.db.run('DELETE FROM fleet');

      const insert = this.db.query(
        'INSERT OR REPLACE INTO fleet (agent_session_id, name, cwd, pinned, last_attached, agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
      );

      for (const entry of all) {
        const pinned = entry.pinned === true ? 1 : 0;

        insert.run(
          entry.agentSessionID,
          entry.name,
          entry.cwd,
          pinned,
          entry.lastAttachedAt ?? null,
          entry.agent,
        );
      }
    });

    replace(entries);
  }

  recordEvent(e: HookEvent): void {
    const rawMessage = e.payload['message'];
    const rawSessionID = e.payload['session_id'] ?? e.payload['sessionId'];
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

  loadLastUsedAgent(): AgentKind {
    const row = this.db
      .query<{ value: string }, []>("SELECT value FROM prefs WHERE key = 'last_used_agent'")
      .get();

    return toAgentKind(row?.value);
  }

  writeLastUsedAgent(agent: AgentKind): void {
    this.db
      .query(
        'INSERT INTO prefs (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
      )
      .run('last_used_agent', agent);
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

      const entries: FleetEntry[] = [];

      for (const entry of parsed) {
        const parsedEntry = parseFleetEntry(entry);

        if (parsedEntry !== undefined) {
          entries.push(parsedEntry);
        }
      }

      this.writeFleet(entries);
    } catch {}
  }
}
