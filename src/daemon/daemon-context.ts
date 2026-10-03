import type { AgentAdapter, SpawnOptions, SpawnOverrides } from '../agents/agent-adapter';
import type { EventMsg } from '../protocol/protocol';
import type { SpawnWorkspaceSource } from '../protocol/request-param-schemas';
import type { AgentID } from '../shared/agent-id';
import type { TargetConfigError } from '../shared/collect-targets';
import type { DaemonID } from '../shared/daemon-id';
import type { MessageID } from '../shared/message-id';
import type { SessionID } from '../shared/session-id';
import type { SourceKind, SourceProvider } from '../sources/types';
import type { FleetEntry } from '../store/fleet-entry';
import type { MessageRecord } from '../store/message-record';
import type { TurnSibling } from '../store/state-store';
import type { checkRepositoryAccess } from '../workspace/check-repository-access';
import type { Dims } from './attach-registry';
import type { AgentEntry } from './build-agent-list';
import type { FleetEvent } from './build-fleet-events';
import type { ReportView } from './build-report-view';
import type { TargetEntry } from './build-target-list';
import type { KeyedRequest } from './idempotency-ledger';
import type { TranscriptPage, TranscriptPosition } from './load-transcript-page';
import type { AnswerResult } from './permission-registry';
import type { ScreenText } from './screen-model';
import type { SessionDescriptor } from './sessions';
import type { TargetAccess, TargetGrant } from './target-access';

export interface SpawnParams {
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly resume: SpawnOptions['resume'];
  readonly namedBy: 'user' | 'auto';
  readonly agent: AgentID;
  readonly parent: SessionID | null;
  readonly overrides: SpawnOverrides;
  readonly target: string;

  // Where the session's working directory comes from; null runs the
  // session in cwd as it stands.
  readonly workspace: SpawnWorkspaceSource | null;
}

interface SessionRecord {
  readonly session: SessionDescriptor;
  readonly prompt: string | null;
  readonly lastActivityAt: number;
  readonly pending: { readonly message: string } | null;
  readonly result: string | null;
}

/**
 * What `session.forget` answers: the token a forget that destroys a host
 * must carry, with the time it stops being taken; or the forgotten session,
 * with whether its host was destroyed.
 */
type ForgetResult =
  | { readonly confirmToken: string; readonly expiresAt: number }
  | { readonly forgotten: true; readonly destroyed: boolean };

// A transcript page with the file it came from, so a cursor into a replaced
// transcript is distinguishable from one into a grown transcript.
interface SessionTranscriptRead {
  readonly path: string;
  readonly page: TranscriptPage;
}

// The `agents.list` answer: the host the daemon runs on, each agent, each
// execution target, what a spawn without either runs with, a digest of
// the target config, and the target config problems the daemon started
// with.
interface AgentList {
  readonly daemon: {
    readonly hostname: string;
    readonly platform: string;
    readonly arch: string;
    readonly build: string;
  };
  readonly agents: readonly AgentEntry[];
  readonly targets: readonly TargetEntry[];
  readonly spawnDefaults: { readonly agent: AgentID; readonly target: string | null };
  readonly configRevision: string;
  readonly targetErrors: readonly TargetConfigError[];

  // The sources the spawn picker offers, in order.
  readonly sources: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: SourceKind;
  }[];
}

// The slice of a connection the attach bookkeeping needs: identity plus the
// ability to receive output events.
export interface OutputClient {
  readonly sendOutput: (sessionID: SessionID, event: EventMsg, byteLength: number) => void;
}

// One `events.read` answer: the events, and whether more follow them.
interface EventsPage {
  readonly events: readonly FleetEvent[];
  readonly more: boolean;
}

// One message as `message.get` reports it: the session it belongs to now,
// every field of the record, and the other messages its turn answered with
// the atc id each was sent to.
interface MessageView {
  readonly session: SessionID;
  readonly record: MessageRecord;
  readonly answeredWith: readonly TurnSibling[];
}

// Why a session refuses a message before the daemon accepts it.
export type MessageRefusal = 'missing' | 'dead' | 'unsupported' | 'no_tap';

// The slice of a connection a tap subscription needs.
export interface TapClient {
  readonly sendEvent: (event: EventMsg) => void;
}

export interface DaemonContext {
  readonly build: string;
  readonly daemonID: DaemonID;
  readonly collectSessions: () => SessionDescriptor[];

  // The directories spawns ran in, most recent first, leaving out each one
  // spawned only on targets outside the access when there is one.
  readonly collectSpawnDirs: (access: TargetAccess | null) => Promise<string[]>;
  readonly collectAgents: () => AgentList;
  readonly collectFleet: () => Promise<FleetEntry[]>;
  readonly loadLastUsedAgent: () => Promise<AgentID>;
  readonly findAdapter: (id: AgentID) => AgentAdapter | null;

  // The targets a principal may use.
  readonly buildTargetAccess: (principal: string) => TargetAccess;

  // The target and identity a session is bound to, or null when no
  // session holds the id.
  readonly findSessionGrant: (id: SessionID) => TargetGrant | null;

  // The identity a target holds now, or null when the config holds no such
  // target.
  readonly findTargetIdentity: (target: string) => string | null;

  // Whether the access reaches every session in the given session's tree:
  // its top-level session and each sub-session of that one. False for an
  // unknown session.
  readonly canSeeSession: (id: SessionID, access: TargetAccess) => boolean;

  // Whether the request this context serves may still see the session: any
  // session for the daemon's owner, and for a principal only a session whose
  // whole tree it reaches. A read answers only after asking this, in the
  // same step as it sends, so no await lies between the check and the send.
  readonly isSessionVisible: (id: SessionID) => boolean;

  // The session a permission request belongs to, answered or not, or null
  // for an unknown request.
  readonly findPermissionSession: (request: string) => SessionID | null;

  // The session a spawn under the given session lands under: that session,
  // or its own parent for a sub-session, so a set stays one level deep.
  // Null spawns the session top-level; 'missing' for an unknown session.
  readonly resolveSpawnParent: (id: SessionID) => SessionID | null | 'missing';

  // The target a spawn runs on: the one it names, else the default. Throws
  // the refusal for a target the spawn cannot run on, and for a spawn
  // without a target when the config gives no default.
  readonly resolveSpawnTarget: (requested: string | undefined) => string;

  // Throws the refusal for a target that cannot materialize a workspace:
  // one whose provider cannot both transfer an archive and run a command.
  readonly requireWorkspaceTarget: (target: string) => void;

  // The source the daemon offers the spawn picker under an id, or null when
  // it offers none under it.
  readonly findSource: (id: string) => SourceProvider | null;

  // Checks that the daemon's host can read a git workspace source, and
  // resolves its ref, the way a workspace spawn from it would.
  readonly checkRepositoryAccess: (
    request: Omit<Parameters<typeof checkRepositoryAccess>[0], 'transports'>,
  ) => ReturnType<typeof checkRepositoryAccess>;

  // Runs the plan, which throws the refusal for a spawn it refuses, then
  // spawns. Answers with the `session.spawn` ok payload, which a keyed
  // retry replays as the first spawn answered it while the access, when
  // there is one, still reaches the target the spawn's session was bound to.
  readonly spawnSession: (
    plan: () => SpawnParams,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly killSession: (id: SessionID) => Promise<boolean>;

  // Forgets a session, or answers with the token a forget that destroys a
  // host must carry. Throws the refusal for a token it does not take.
  readonly forgetSession: (
    id: SessionID,
    confirmToken: string | undefined,
  ) => Promise<ForgetResult | 'missing'>;
  readonly updateSession: (id: SessionID, name?: string, pinned?: boolean) => boolean | 'child_pin';
  readonly quitDaemon: () => void;
  readonly ackSession: (id: SessionID) => boolean;
  readonly buildResumeCommand: (id: SessionID) => string | null;
  readonly readSessionScreen: (id: SessionID) => Promise<ScreenText | 'missing' | 'no_screen'>;
  readonly answerPermission: (request: string, decision: string) => AnswerResult;
  readonly restoreFleet: (cols: number, rows: number) => Promise<number>;
  readonly attachSession: (
    client: OutputClient,
    sessionID: SessionID,
    dims: Dims,
  ) => 'ok' | 'missing' | 'dead';
  readonly detachSession: (client: OutputClient, sessionID: SessionID) => void;
  readonly detachClient: (client: OutputClient) => void;
  readonly writeSessionInput: (
    sessionID: SessionID,
    data: string,
  ) => 'busy' | 'ok' | 'missing' | 'dead';

  // Types a line into the session and submits it the way the session's
  // agent accepts a line, as opposed to the raw bytes the input write takes.
  readonly writeSessionLine: (
    sessionID: SessionID,
    text: string,
  ) => 'busy' | 'ok' | 'missing' | 'dead';
  readonly ejectSession: (
    id: SessionID,
    prompt: string,
  ) => 'ok' | 'missing' | 'unsupported' | 'no_transcript';

  // Starts a harness for a dead or headless session. Under an access, the
  // adopt answers 'missing' once the session's tree leaves it, however late.
  readonly adoptSession: (
    id: SessionID,
    cols: number,
    rows: number,
    access: TargetAccess | null,
  ) => Promise<'ok' | 'missing' | 'no_transcript'>;
  readonly resizeSession: (client: OutputClient, sessionID: SessionID, dims: Dims) => boolean;
  readonly resyncClient: (sessionID: SessionID, client: OutputClient) => Promise<void>;
  readonly queueBytes?: number;
  readonly getEffectiveDims: (sessionID: SessionID) => Dims;

  // The session's record. Its activity time counts only the session's own
  // trail rows when there is an access.
  readonly readSessionRecord: (
    id: SessionID,
    access: TargetAccess | null,
  ) => Promise<SessionRecord | 'missing'>;
  readonly loadSessionTranscript: (
    id: SessionID,
    from: TranscriptPosition | null,
    limit: number,
  ) => Promise<SessionTranscriptRead | 'missing' | 'unsupported'>;

  // Reads the trail, leaving out each event of a session outside the access
  // when there is one.
  readonly readEvents: (
    afterID: number | null,
    limit: number,
    waitMs: number,
    sessionID: SessionID | null,
    access: TargetAccess | null,
  ) => Promise<EventsPage>;

  // One report by the trail id of its event, with the atc id of the session
  // that sent it, or null for a trail id that holds no report, or whose
  // report's session is outside the access when there is one. The view may
  // name the report by another session; who may read it is checked against
  // the sender.
  readonly readReport: (
    id: number,
    access: TargetAccess | null,
  ) => Promise<{ readonly owner: SessionID; readonly view: ReportView } | null>;

  // Answers with the `session.message` ok payload, which a keyed retry
  // replays with the message's current status, or with the refusal. Under
  // an access, a session whose tree leaves it before the write refuses as
  // 'missing'.
  readonly writeSessionMessage: (
    sessionID: SessionID,
    from: string,
    text: string,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
  ) => Promise<Readonly<Record<string, unknown>> | MessageRefusal>;
  readonly readMessage: (messageID: MessageID, waitMs: number) => Promise<MessageView | null>;

  // Makes the client the session's inbox tap. Under an access, the tap
  // takes only the messages sent to the session's atc id.
  readonly attachTap: (
    client: TapClient,
    sessionID: SessionID,
    access: TargetAccess | null,
  ) => 'ok' | 'missing' | 'unsupported';

  // Lets go of the session's inbox tap when the client holds it, so its
  // messages wait for another tap.
  readonly detachTap: (client: TapClient, sessionID: SessionID) => void;

  // Marks a tapped message delivered. Under an access, only a message sent
  // to the session's atc id counts as the session's.
  readonly ackMessage: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
    access: TargetAccess | null,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;
}
