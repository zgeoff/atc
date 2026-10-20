import type { AgentSessionID, SessionID } from '@atc/core';
import { toAgentSessionID, toMessageID, toSessionID } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { sql } from 'kysely';
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely';
import type { StateStoreSchema } from './sqlite/state-store-schema';
import type { EventScope, StoredAnswer, StoredEvent, StoredNote } from './stored-event';
import type { TrailEntry } from './trail-entry';

// Spelled as the partial index's predicate so SQLite can match them.
const TRAIL_FILTER = sql<boolean>`kind IS NOT NULL AND kind != 'heartbeat'`;

// The hook events and trail entries a session leaves behind, kept in the
// events table.
export class EventTrailStore {
  private readonly db: Kysely<StateStoreSchema>;

  constructor(db: Kysely<StateStoreSchema>) {
    this.db = db;
  }

  // The latest hook-event timestamp per agent session id, from the event
  // trail. Sessions that never reported an event are absent.
  async readFleetRecency(): Promise<Map<AgentSessionID, string>> {
    const rows = await this.db
      .selectFrom('events')
      .select(['session_id', sql<string>`MAX(ts)`.as('ts')])
      .where('session_id', 'is not', null)
      .groupBy('session_id')
      .execute();

    const recency = new Map<AgentSessionID, string>();

    for (const row of rows) {
      if (row.session_id === null) {
        continue;
      }

      recency.set(toAgentSessionID(row.session_id), row.ts);
    }

    return recency;
  }

  // Records a hook event in the trail, stamped with the given time in epoch
  // milliseconds, or the system clock's when absent.
  async recordEvent(
    hookEvent: HookEvent,
    ev: Readonly<AdapterEvent> | null,
    at: number,
  ): Promise<void> {
    const rawMessage = hookEvent.payload['message'];
    const rawSessionID = hookEvent.payload['session_id'] ?? hookEvent.payload['sessionId'];
    const message = typeof rawMessage === 'string' ? rawMessage : null;
    const sessionID = typeof rawSessionID === 'string' ? rawSessionID : null;
    const atcID: string = hookEvent.atcId;

    await this.db
      .insertInto('events')
      .values({
        ts: new Date(at).toISOString(),
        atc_id: atcID,
        event: hookEvent.event,
        message,
        session_id: sessionID,
        kind: ev === null ? null : ev.kind,
        detail: ev?.detail ?? null,
      })
      .execute();
  }

  // Returns whether the entry was written: a note whose id the trail
  // already holds is left out.
  async recordTrailEntry(entry: TrailEntry): Promise<boolean> {
    const result = await this.db
      .insertInto('events')
      .values({
        ts: new Date(entry.at).toISOString(),
        atc_id: entry.atcID,
        event: entry.kind === 'note' ? 'SessionNote' : 'SessionMessage',

        // The message column holds the message id or the note label; the reads hand it back by kind.
        message: entry.kind === 'note' ? entry.label : entry.message,
        session_id: entry.agentSessionID,
        kind: entry.kind,
        detail: entry.detail,
        note_id: entry.kind === 'note' ? (entry.noteID ?? null) : null,
        note_text: entry.kind === 'note' ? entry.text : null,
        answer_text: entry.kind === 'message-answered' ? entry.text : null,
      })
      .onConflict((oc) => oc.column('note_id').doNothing())
      .executeTakeFirst();

    return result.numInsertedOrUpdatedRows !== 0n;
  }

  async readEventsAfter(
    afterID: number,
    limit: number,
    scope: EventScope | null,
  ): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where('id', '>', afterID)
      .where(TRAIL_FILTER)
      .where((eb) => buildScopeMatch(eb, scope))
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return buildStoredEvents(rows);
  }

  // A row that is not a note, or that lies outside the scope, misses as a
  // row the trail never held does.
  async readNote(id: number, scope: EventScope | null): Promise<StoredNote | null> {
    const row = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'message', 'detail', 'note_text'])
      .where('id', '=', id)
      .where('kind', '=', 'note')
      .where((eb) => buildScopeMatch(eb, scope))
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    return {
      id: row.id,
      at: Date.parse(row.ts),
      atcID: toSessionID(row.atc_id),
      agentSessionID: row.session_id === null ? null : toAgentSessionID(row.session_id),
      label: row.message ?? '',
      text: row.note_text ?? row.detail ?? '',
      complete: row.note_text !== null,
    };
  }

  // A row that is not an answered message, or that lies outside the scope,
  // misses as a row the trail never held does.
  async readAnswer(id: number, scope: EventScope | null): Promise<StoredAnswer | null> {
    const row = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'message', 'detail', 'answer_text'])
      .where('id', '=', id)
      .where('kind', '=', 'message-answered')
      .where((eb) => buildScopeMatch(eb, scope))
      .executeTakeFirst();

    if (row === undefined || row.message === null) {
      return null;
    }

    return {
      id: row.id,
      at: Date.parse(row.ts),
      atcID: toSessionID(row.atc_id),
      agentSessionID: row.session_id === null ? null : toAgentSessionID(row.session_id),
      message: toMessageID(row.message),
      text: row.answer_text ?? row.detail ?? '',
      complete: row.answer_text !== null,
    };
  }

  async readLatestEvents(limit: number, scope: EventScope | null): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where(TRAIL_FILTER)
      .where((eb) => buildScopeMatch(eb, scope))
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();

    return buildStoredEvents(rows).toReversed();
  }

  // Matches the session by either id, since rows written before atc session
  // ids stayed stable across restores carry an earlier atc id.
  async loadLastActivityAt(
    atcID: SessionID,
    agentSessionID: AgentSessionID | undefined,
  ): Promise<number | null> {
    const row = await this.db
      .selectFrom('events')
      .select(sql<string | null>`MAX(ts)`.as('ts'))
      .where((eb) =>
        eb.or([
          eb('atc_id', '=', atcID),
          ...(agentSessionID === undefined ? [] : [eb('session_id', '=', agentSessionID)]),
        ]),
      )
      .executeTakeFirst();

    return row?.ts === null || row?.ts === undefined ? null : Date.parse(row.ts);
  }

  // The newest row under each atc id and each agent session id stays, so a
  // session's last activity and restore order survive; past the cutoff it
  // stays only while a fleet row holds either id.
  async removeExpiredEvents(before: number): Promise<void> {
    const cutoff = new Date(before).toISOString();

    await this.db
      .deleteFrom('events')
      .where(
        sql<boolean>`(ts < ${cutoff} OR NOT (${TRAIL_FILTER})) AND (
          (ts < ${cutoff} AND NOT EXISTS (
            SELECT 1 FROM fleet
            WHERE fleet.session_id = events.atc_id
              OR (events.session_id IS NOT NULL AND fleet.agent_session_id = events.session_id)
          ))
          OR (
            ts < (SELECT MAX(newer.ts) FROM events AS newer WHERE newer.atc_id = events.atc_id)
            AND (
              events.session_id IS NULL
              OR ts < (SELECT MAX(newer.ts) FROM events AS newer WHERE newer.session_id = events.session_id)
            )
          )
        )`,
      )
      .execute();
  }

  // Trail entries written before the agent reported its session id carry
  // none; this stamps them once it is known, so they follow the session
  // across a restore.
  async updateTrailOwner(atcID: SessionID, next: AgentSessionID): Promise<void> {
    await this.db
      .updateTable('events')
      .set({ session_id: next })
      .where('atc_id', '=', atcID)
      .where('session_id', 'is', null)
      .where('kind', 'in', [
        'message-queued',
        'message-delivered',
        'message-answered',
        'message-unanswered',
        'notice-queued',
        'notice-delivered',
        'note',
      ])
      .execute();
  }
}

function buildScopeMatch(
  eb: ExpressionBuilder<StateStoreSchema, 'events'>,
  scope: EventScope | null,
): Expression<SqlBool> {
  if (scope === null) {
    return eb.lit(true);
  }

  if (scope.atcIDs.length === 0 && scope.agentSessionIDs.length === 0) {
    return eb.lit(false);
  }

  return eb.or([
    ...(scope.atcIDs.length === 0 ? [] : [eb('atc_id', 'in', scope.atcIDs)]),
    ...(scope.agentSessionIDs.length === 0 ? [] : [eb('session_id', 'in', scope.agentSessionIDs)]),
  ]);
}

interface EventRow {
  readonly id: number;
  readonly ts: string;
  readonly atc_id: string;
  readonly session_id: string | null;
  readonly kind: string | null;
  readonly detail: string | null;
  readonly message: string | null;
}

function buildStoredEvents(rows: readonly EventRow[]): StoredEvent[] {
  const events: StoredEvent[] = [];

  for (const row of rows) {
    if (row.kind === null) {
      continue;
    }

    events.push({
      id: row.id,
      at: Date.parse(row.ts),
      atcID: toSessionID(row.atc_id),
      agentSessionID: row.session_id === null ? null : toAgentSessionID(row.session_id),
      kind: row.kind,
      ...buildTrailFields(row.kind, row.detail, row.message),
    });
  }

  return events;
}

const MESSAGE_TRAIL_KINDS: ReadonlySet<string> = new Set([
  'message-queued',
  'message-delivered',
  'message-answered',
  'message-unanswered',
  'notice-queued',
  'notice-delivered',
]);

// Message and note rows keep their message id or label where hook rows keep
// the hook's message, so only hook rows fall back to it for a detail.
function buildTrailFields(
  kind: string,
  detail: string | null,
  message: string | null,
): Pick<StoredEvent, 'detail' | 'message' | 'label'> {
  if (MESSAGE_TRAIL_KINDS.has(kind)) {
    return { detail, ...(message === null ? {} : { message: toMessageID(message) }) };
  }

  if (kind === 'note') {
    return { detail, ...(message === null ? {} : { label: message }) };
  }

  return { detail: detail ?? message };
}
