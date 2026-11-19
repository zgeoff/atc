import type { Generated } from 'kysely';
import type {
  RuntimeAuthBindingState,
  RuntimeAuthGrantPhase,
} from '../auth-bindings/runtime-auth-binding';
import type { IdempotencyState } from '../idempotency/idempotency-record';
import type { MaterializationPhase } from '../materializations/workspace-materialization';
import type { MessageStatus } from '../messages/message-record';

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

  plugin_dirs: string | null;
  target: string | null;
  target_identity: string | null;

  desired: string | null;

  host_key: string | null;

  auth_revision: number | null;

  agent_home: string | null;

  suspended: number | null;

  atc_access: string | null;

  spawner_session_id: string | null;

  trusted_root: string | null;
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

  note_id: string | null;

  note_text: string | null;

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

interface SessionOwnerTable {
  session_id: string;
  daemon_id: string;
  owner_epoch: Generated<number>;
  updated_at: number;
}

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

  effect_target: string | null;
  effect_target_identity: string | null;
}

interface WorkspaceMaterializationTable {
  session_id: string;
  target: string;
  directory: string;
  source_kind: 'path' | 'git';
  phase: MaterializationPhase;
  repo_url: string | null;
  sha: string | null;
  ref: string | null;
  error_code: string | null;
  started_at: number;
  updated_at: number;
  materialized_at: number | null;

  withheld_env: string | null;
}

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

interface RuntimeAuthGrantTable {
  host_key: string;
  secret: string;
  revision: number;
  attempt_id: string;
  preexisting: number;
  phase: RuntimeAuthGrantPhase;
  updated_at: number;
}

interface PublishedRecordTable {
  session_id: string;

  record: string;
  revision: number;
  updated_at: number;
}

interface MessagesTable {
  id: string;
  atc_id: string;
  agent_session_id: string | null;
  sender: string;

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

  turn_id: string | null;

  sender_session: string | null;

  notice_queued_at: number | null;
  notice_delivered_at: number | null;
}

interface RestartResultsTable {
  event_id: number;

  result: string;
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
  restart_results: RestartResultsTable;
}
