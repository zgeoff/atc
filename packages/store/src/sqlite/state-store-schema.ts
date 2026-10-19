import type { Generated } from 'kysely';
import type { IdempotencyState } from '../idempotency-record';
import type { MessageStatus } from '../message-record';
import type { RuntimeAuthBindingState, RuntimeAuthGrantPhase } from '../runtime-auth-binding';
import type { MaterializationPhase } from '../workspace-materialization';

interface FleetTable {
  session_id: string;
  agent_session_id: string | null;
  name: string;
  cwd: string;
  pinned: number;
  last_attached: number | null;
  agent: string;
  exited: number;
  parent_session_id: string | null;
  prompt: string | null;
  result: string | null;
  transcript_path: string | null;
  model: string | null;
  effort: string | null;

  // The JSON array of plugin folders the spawn asked for, or null for a row
  // that stores no plugin folders.
  plugin_dirs: string | null;
  target: string | null;
  target_identity: string | null;

  // What the operator asked of the session's harness: null keeps it
  // running, `sleep` keeps its host asleep, and `stop` leaves it ended.
  desired: string | null;

  // The session whose host this session's harness runs on: its own id, or
  // its parent's when the two share one host. Null for a row from before
  // hosts were recorded, which runs on its own.
  host_key: string | null;

  // The runtime auth revision the session's latest harness launched under.
  // Null for a harness that takes no credential from the broker, and for
  // a row from before launch revisions were recorded.
  auth_revision: number | null;

  // 1 when the harness is kept inside a host that went to sleep, so a restore
  // after a daemon restart lists it as suspended; 0 for any other harness, and
  // null for a row from before sleeps were recorded.
  suspended: number | null;
}

interface EventsTable {
  id: Generated<number>;
  ts: string;
  atc_id: string;
  event: string;
  message: string | null;
  session_id: string | null;
  kind: string | null;
  detail: string | null;

  // The id a remote session's reporter gave a note row, unique so a
  // resent note lands once; null on every other row.
  note_id: string | null;

  // A note row's whole text, which detail previews; null on every other
  // row, and on a note row written before the column existed.
  note_text: string | null;

  // A message-answered row's whole answer, which detail previews; null on
  // every other row, and on a message-answered row written before the
  // column existed.
  answer_text: string | null;
}

interface SpawnHistoryTable {
  cwd: string;
  target: string;
  target_identity: string;
  last_spawn: number;
}

interface PrefsTable {
  key: string;
  value: string;
}

// Which daemon owns each persisted session, and under which ownership
// epoch. A write from a daemon whose epoch is behind the stored one is
// stale and rejected.
interface SessionOwnerTable {
  session_id: string;
  daemon_id: string;
  owner_epoch: Generated<number>;
  updated_at: number;
}

// One key per principal and operation. A key whose outcome is unknown never
// expires, so a retry of it can never start a fresh effect.
interface IdempotencyTable {
  principal: string;
  operation: string;
  key: string;
  payload_hash: string;
  state: IdempotencyState;
  effect_ref: string;
  result: string | null;
  created_at: number;
  updated_at: number;

  // The target, and its identity, the completed effect's session was bound
  // to; null for a key completed without one.
  effect_target: string | null;
  effect_target_identity: string | null;
}

// One spawn's workspace on its way to the execution target, keyed by the
// session it is for.
interface WorkspaceMaterializationTable {
  session_id: string;
  target: string;
  dir: string;
  source_kind: 'path' | 'git';
  phase: MaterializationPhase;
  repo_url: string | null;
  sha: string | null;
  ref: string | null;
  error_code: string | null;
  started_at: number;
  updated_at: number;
  materialized_at: number | null;

  // JSON array of the environment variable names every harness the session
  // starts goes without; names only, never their values.
  withheld_env: string | null;
}

// One host's runtime auth binding, keyed by the session that owns the host.
// The rebind columns hold a rebind in flight or the one that failed, all
// null otherwise.
interface RuntimeAuthBindingTable {
  host_key: string;
  target: string;
  target_identity: string;
  host_name: string;
  host_id: string | null;
  revision: number;
  binding_hash: string;
  binding_json: string;
  state: RuntimeAuthBindingState;
  attempt_id: string;
  host_created_by_attempt: number;
  rebind_revision: number | null;
  rebind_binding_hash: string | null;
  rebind_binding_json: string | null;
  rebind_attempt_id: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

// One secret's grant to a host, keyed by the host and the secret.
interface RuntimeAuthGrantTable {
  host_key: string;
  secret: string;
  revision: number;
  attempt_id: string;
  preexisting: number;
  phase: RuntimeAuthGrantPhase;
  updated_at: number;
}

// One session's published record, keyed by the session.
interface PublishedRecordTable {
  session_id: string;

  // The record as JSON, in the format its version defines.
  record: string;
  revision: number;
  updated_at: number;
}

interface MessagesTable {
  id: string;
  atc_id: string;
  agent_session_id: string | null;
  sender: string;

  // The kind of caller that sent the message (connector, session or owner) and
  // the connector's client id or the session's atc id; null on a row from before
  // senders were typed, and the id null for the owner.
  sender_kind: string | null;
  sender_id: string | null;
  text: string;
  status: MessageStatus;
  sent_at: number;
  delivered_at: number | null;
  answered_at: number | null;
  answer: string | null;
  unanswered_at: number | null;
  unanswered_reason: string | null;

  // The turn whose final reply is the answer, or the turn that ended without
  // one; null for a message settled without one.
  turn_id: string | null;

  // The atc id of the session that sent the message, taken from the caller
  // the daemon saw; null for a sender that takes no answer notices.
  sender_session: string | null;

  // When the answer notice to the sender was queued and when its tap took
  // it; null until each happens.
  notice_queued_at: number | null;
  notice_delivered_at: number | null;
}

export interface StateStoreSchema {
  fleet: FleetTable;
  events: EventsTable;
  spawn_history: SpawnHistoryTable;
  prefs: PrefsTable;
  messages: MessagesTable;
  session_owner: SessionOwnerTable;
  idempotency: IdempotencyTable;
  workspace_materialization: WorkspaceMaterializationTable;
  runtime_auth_binding: RuntimeAuthBindingTable;
  runtime_auth_grant: RuntimeAuthGrantTable;
  published_record: PublishedRecordTable;
}
