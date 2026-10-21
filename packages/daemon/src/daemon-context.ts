import type { TargetConfigError } from '@atc/config';
import type { AgentID, DaemonID, MessageID, SessionID } from '@atc/core';
import type {
  AgentAdapter,
  SourceKind,
  SourceProvider,
  SpawnOptions,
  SpawnOverrides,
} from '@atc/plugin-api';
import type {
  DaemonAnswer,
  DeclaredScope,
  MenuView,
  PublishedRecord,
  RestartResult,
  SessionDescriptor,
  SpawnWorkspaceSource,
} from '@atc/protocol';
import type { EventMsg } from '@atc/protocol/wire';
import type { FleetEntry, MessageRecord, TurnSibling } from '@atc/store';
import type { AuthRebound } from './auth/auth-setup';
import type { TargetAccess, TargetGrant } from './auth/target-access';
import type { FleetEvent } from './fleet/build-fleet-events';
import type { TargetEntry } from './fleet/build-target-list';
import type { MenuChoice, MenuChoiceResult } from './sessions/apply-menu-choice';
import type { Dims } from './sessions/attach-registry';
import type { AgentEntry } from './sessions/build-agent-list';
import type { AnswerView } from './sessions/build-answer-view';
import type { NoteView } from './sessions/build-note-view';
import type { TranscriptPage, TranscriptPosition } from './sessions/load-transcript-page';
import type { MessageCaller } from './sessions/message-caller';
import type { AnswerResult } from './sessions/permission-registry';
import type { ResumeCommand } from './sessions/plan-resume-command';
import type { ScreenText } from './sessions/screen-model';
import type { SessionChanges } from './sessions/session-changes';
import type { KeyedRequest } from './transport/idempotency-ledger';
import type { checkRepositoryAccess } from './workspace/check-repository-access';

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

  // The scope beyond its workspace the session's record holds once each
  // entry is checked on its host; null declares none.
  readonly scope: DeclaredScope | null;

  // Whether the daemon picked cwd for a git workspace the spawn gave no
  // directory for, so a held directory moves the spawn to a numbered one
  // beside it.
  readonly autoDir: boolean;
}

export interface SessionRecord {
  readonly session: SessionDescriptor;
  readonly prompt: string | null;
  readonly lastActivityAt: number;
  readonly pending: { readonly message: string } | null;
  readonly result: string | null;

  // The record atc publishes for the session; null for a session that has
  // none yet.
  readonly sessionRecord: PublishedRecord | null;
}

export type ForgetResult =
  | { readonly confirmToken: string; readonly expiresAt: number }
  | { readonly forgotten: true; readonly destroyed: boolean };

// a pinned session, or a sub-session of one unless the pin belongs to the caller or a
// session above the caller; and a live session
export interface ForgetRefusals {
  readonly pinned: boolean;
  readonly live: boolean;
}

// A transcript page with the file it came from, so a cursor into a replaced
// transcript is distinguishable from one into a grown transcript.
export interface SessionTranscriptRead {
  readonly path: string;
  readonly page: TranscriptPage;
}

// the `agents.list` answer
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

export type KillOutcome = 'stopped' | 'unchanged' | 'removed' | 'missing';

export interface DaemonContext {
  readonly build: string;
  readonly daemonID: DaemonID;

  // How long the daemon keeps a completed idempotency key, which the
  // handshake announces so a caller knows how long a retry stays deduplicated.
  readonly idempotencyRetentionMs: number;
  readonly collectSessions: () => SessionDescriptor[];

  // The directories spawns ran in, most recent first, leaving out each one
  // spawned only on targets outside the access when there is one.
  readonly readSpawnDirs: (access: TargetAccess | null) => Promise<string[]>;
  readonly collectAgents: () => AgentList;
  readonly readFleet: () => Promise<FleetEntry[]>;
  readonly loadLastUsedAgent: () => Promise<AgentID>;
  readonly findAdapter: (id: AgentID) => AgentAdapter | null;

  // The targets a principal may use.
  readonly buildTargetAccess: (principal: string) => TargetAccess;

  // Whether the config's principals key lists the principal, which a
  // request over TCP must act as.
  readonly hasListedPrincipal: (principal: string) => boolean;

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

  // any session for the daemon's owner, and for a principal only one whose whole tree
  // it reaches; a read asks this in the same step as it sends, with no await between
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

  // The directory a git workspace lands in on a target when the spawn
  // gives none: absolute on the daemon's own machine, and relative to the
  // target user's home on a remote target.
  readonly buildDefaultWorkspaceDir: (
    target: string,
    source: Extract<SpawnWorkspaceSource, { kind: 'git' }>,
  ) => string;

  // Throws the refusal for an agent that takes its credential from impd's
  // broker on a target whose provider reaches no broker.
  readonly requireAgentTarget: (agent: AgentID, target: string) => void;

  // The spawn's own plugin folders, expanded and normalized. Throws the
  // refusal for any folder on a remote target, and for a configured or
  // requested path that is not a folder on the daemon's machine.
  readonly requirePluginDirs: (
    target: string,
    configured: readonly string[],
    requested: readonly string[],
  ) => string[];

  // The source the daemon offers the spawn picker under an id, or null when
  // it offers none under it.
  readonly findSource: (id: string) => SourceProvider | null;

  // The other URLs the offered sources know for a git URL the daemon's host
  // could not read, each once.
  readonly collectAlternateGitURLs: (url: string) => readonly string[];

  // Checks that the daemon's host can read a git workspace source, and
  // resolves its ref, the way a workspace spawn from it would.
  readonly checkRepositoryAccess: (
    request: Omit<Parameters<typeof checkRepositoryAccess>[0], 'transports'>,
  ) => ReturnType<typeof checkRepositoryAccess>;

  // runs the plan, which throws the refusal for a spawn it refuses, then spawns; a keyed
  // retry replays the first answer while the access, when there is one, still reaches
  // the target the spawn's session was bound to
  readonly spawnSession: (
    plan: () => SpawnParams,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
  ) => Promise<DaemonAnswer<'session.spawn'>>;

  // Kills a session, or with stopOnly stops one that is live and leaves an
  // exited one alone. Answers what happened to it.
  readonly killSession: (id: SessionID, stopOnly: boolean) => Promise<KillOutcome>;

  // answers with the token a forget that destroys a host must carry; throws for a token it
  // does not take, and for a pinned or live session the caller asks it to refuse; the
  // caller is the requesting session, or null for a client outside any session
  readonly forgetSession: (
    id: SessionID,
    confirmToken: string | undefined,
    refuse: ForgetRefusals,
    caller: SessionID | null,
  ) => Promise<ForgetResult | 'missing'>;

  // Withdraws the grants of the runtime auth binding on a session's host,
  // and answers false for no such session.
  readonly revokeSessionAuth: (id: SessionID) => Promise<boolean>;

  // Binds a session's host to its agent's current auth selection, and
  // answers the new revision with the sessions whose harness reads it only
  // at its next launch, or null for no such session.
  readonly updateSessionAuth: (id: SessionID) => Promise<AuthRebound | null>;

  // false for no such session, 'shared_host' for a detach or pin of a sub-session in its
  // parent's host, and 'agent_named' when the other changes applied but the rename was
  // skipped because the agent named the session itself
  readonly updateSession: (
    id: SessionID,
    changes: SessionChanges,
  ) => boolean | 'shared_host' | 'agent_named';

  // Adds a checked scope to a session's published record and returns the
  // record as it stands after; 'missing' for no such session.
  readonly updateSessionScope: (
    id: SessionID,
    scope: DeclaredScope,
  ) => Promise<PublishedRecord | 'missing'>;

  // Whether the session is the caller itself or a session the caller is a
  // sub-session of, at any depth.
  readonly isCallerTree: (id: SessionID, caller: SessionID) => boolean;
  readonly quitDaemon: () => void;
  readonly announceRestart: (result: RestartResult) => Promise<void>;
  readonly ackSession: (id: SessionID) => boolean;
  readonly planResumeCommand: (id: SessionID) => ResumeCommand;
  readonly readSessionScreen: (id: SessionID) => Promise<ScreenText | 'missing' | 'no_screen'>;

  // The menu the session's agent waits on, read from its screen, or null
  // when the screen shows none. 'unsupported' is an agent whose adapter
  // reads no menus.
  readonly readSessionMenu: (
    id: SessionID,
  ) => Promise<MenuView | null | 'missing' | 'no_screen' | 'unsupported'>;

  // picks an option, or presses Escape, behind any input already queued for the session;
  // a choice the screen does not match rejects and writes nothing that picks an option
  readonly applySessionMenuChoice: (
    id: SessionID,
    choice: MenuChoice,
  ) => Promise<MenuChoiceResult | 'missing' | 'dead' | 'unsupported'>;
  readonly answerPermission: (request: string, decision: string) => AnswerResult;
  readonly restoreFleet: (cols: number, rows: number) => Promise<number>;

  // Writes a consistent copy of the state database to a path on the
  // daemon's host, replacing any file there, and resolves to its size in
  // bytes.
  readonly writeStateBackup: (path: string) => Promise<number>;
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

  // submits a line the way the session's agent accepts one, settling once its last write
  // has gone; a session waiting on a permission prompt refuses it, since typed text
  // would confirm the prompt's highlighted option
  readonly writeSessionLine: (
    sessionID: SessionID,
    text: string,
  ) => Promise<'busy' | 'ok' | 'missing' | 'dead' | 'permission_pending'>;
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

  // null for a trail id that holds no note, or whose note's session is outside the
  // access; the view may name the note by another session, but who may read it is
  // checked against the sender
  readonly readNote: (
    id: number,
    access: TargetAccess | null,
  ) => Promise<{ readonly owner: SessionID; readonly view: NoteView } | null>;

  // null for a trail id that holds no answer, or whose answering session is outside the
  // access; who may read it is checked against the answering session
  readonly readAnswer: (
    id: number,
    access: TargetAccess | null,
  ) => Promise<{ readonly owner: SessionID; readonly view: AnswerView } | null>;

  // a keyed retry replays with the message's current status; under an access, a session
  // whose tree leaves it before the write refuses as 'missing'; the sender session takes
  // the answer notice when it takes messages and, under an access, its tree is in reach
  readonly writeSessionMessage: (
    sessionID: SessionID,
    caller: MessageCaller,
    text: string,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
    senderSession: SessionID | null,
  ) => Promise<DaemonAnswer<'session.message'> | MessageRefusal>;
  readonly readMessage: (messageID: MessageID, waitMs: number) => Promise<MessageView | null>;

  // Makes the client the session's inbox tap. Under an access, the tap
  // takes only the messages sent to the session's atc id. A tap with
  // notices also takes the answer notices of the messages the session sent.
  readonly attachTap: (
    client: TapClient,
    sessionID: SessionID,
    access: TargetAccess | null,
    notices: boolean,
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

  // Marks a tapped answer notice delivered: the notice of a message the
  // session sent.
  readonly ackNotice: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;
}
