import type { TargetConfigError } from '@atc/config';
import type { AgentID } from '@atc/core';
import type {
  AgentAdapter,
  SourceKind,
  SourceProvider,
  SpawnOptions,
  SpawnOverrides,
} from '@atc/plugin-api';
import type { DaemonAnswer, DeclaredScope } from '@atc/protocol';
import type { EventMsg } from '@atc/protocol/wire';
import type { FleetEntry, MessageRecord, TurnSibling } from '@atc/store';
import type {
  DaemonID,
  GrantScope,
  MenuView,
  MessageID,
  PublishedRecord,
  RestartResult,
  SessionDescriptor,
  SessionID,
  SpawnWorkspaceSource,
  WorkspaceCleanup,
  WorkspacePrune,
} from '@atcx/contract';
import type { TargetAccess, TargetGrant } from './auth/build-target-access-from-grants';
import type { GrantedSpawn } from './auth/find-granted-spawn-refusal';
import type { AuthRebound } from './auth/types';
import type { FleetEvent } from './fleet/build-fleet-events';
import type { TargetEntry } from './fleet/build-target-list';
import type { MenuChoice, MenuChoiceResult } from './sessions/apply-menu-choice';
import type { AgentEntry } from './sessions/build-agent-list';
import type { AnswerView } from './sessions/build-answer-view';
import type { NoteView } from './sessions/build-note-view';
import type { Dims } from './sessions/create-attach-registry';
import type { AnswerResult } from './sessions/create-permission-registry';
import type { ScreenText } from './sessions/create-screen-model';
import type { SessionWatch } from './sessions/create-session-output';
import type { TranscriptPage, TranscriptPosition } from './sessions/load-transcript-page';
import type { MessageCaller } from './sessions/message-caller';
import type { ResumeCommand } from './sessions/plan-resume-command';
import type { SessionChanges } from './sessions/session-changes';
import type { KeyedRequest } from './transport/create-idempotency-ledger';
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

  readonly spawner: SessionID | null;

  readonly atcAccess: readonly GrantScope[] | null;
  readonly overrides: SpawnOverrides;
  readonly target: string;

  readonly workspace: SpawnWorkspaceSource | null;

  readonly scope: DeclaredScope | null;

  // Whether the daemon picked cwd for a git workspace the spawn gave no
  // directory for, so a held directory moves the spawn to a numbered one
  // beside it.
  readonly autoDir: boolean;
}

export interface HeldAtcAccess {
  readonly scopes: readonly GrantScope[];

  readonly grant: TargetGrant;
  readonly parent: SessionID | null;
  readonly spawner: SessionID | null;
}

export interface SessionRecord {
  readonly session: SessionDescriptor;
  readonly prompt: string | null;
  readonly lastActivityAt: number;
  readonly pending: { readonly message: string } | null;
  readonly result: string | null;

  readonly sessionRecord: PublishedRecord | null;
}

export type ForgetResult =
  | { readonly confirmToken: string; readonly expiresAt: number }
  | {
      readonly forgotten: true;
      readonly destroyed: boolean;
      readonly workspace: WorkspaceCleanup;
    };

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

  readonly sources: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: SourceKind;
  }[];
}

export interface OutputClient {
  readonly sendOutput: (sessionID: SessionID, event: EventMsg, byteLength: number) => void;
}

interface EventsPage {
  readonly events: readonly FleetEvent[];
  readonly more: boolean;
}

interface MessageView {
  readonly session: SessionID;
  readonly record: MessageRecord;
  readonly answeredWith: readonly TurnSibling[];
}

export type MessageRefusal = 'missing' | 'dead' | 'unsupported' | 'no_tap';

export interface TapClient {
  readonly sendEvent: (event: EventMsg) => void;
}

export type KillOutcome = 'stopped' | 'unchanged' | 'removed' | 'missing';

export interface ReadEventsParams {
  readonly afterID: number | null;
  readonly limit: number;
  readonly waitMs: number;
  readonly sessionID: SessionID | null;
  readonly access: TargetAccess | null;
}

export interface WriteSessionMessageParams {
  readonly sessionID: SessionID;
  readonly caller: MessageCaller;
  readonly text: string;
  readonly keyed: KeyedRequest | null;
  readonly access: TargetAccess | null;
  readonly senderSession: SessionID | null;
}

export interface DaemonContext {
  readonly build: string;
  readonly daemonID: DaemonID;

  // How long the daemon keeps a completed idempotency key, which the
  // handshake announces so a caller knows how long a retry stays deduplicated.
  readonly idempotencyRetentionMs: number;
  readonly collectSessions: () => SessionDescriptor[];

  readonly readSpawnDirs: (access: TargetAccess | null) => Promise<string[]>;
  readonly collectAgents: () => AgentList;
  readonly readFleet: () => Promise<FleetEntry[]>;
  readonly loadLastUsedAgent: () => Promise<AgentID>;
  readonly findAdapter: (id: AgentID) => AgentAdapter | null;

  readonly buildTargetAccess: (principal: string) => TargetAccess;

  readonly requireGrantedSpawn: (spawn: GrantedSpawn) => void;

  readonly hasListedPrincipal: (principal: string) => boolean;

  readonly findSessionGrant: (id: SessionID) => TargetGrant | null;

  readonly findTargetIdentity: (target: string) => string | null;

  readonly findHeldAtcAccess: (id: SessionID) => HeldAtcAccess | null;

  readonly collectSubtree: (id: SessionID) => ReadonlySet<SessionID>;

  readonly canSeeSession: (id: SessionID, access: TargetAccess) => boolean;

  // any session for the daemon's owner, and for a principal only one whose whole tree
  // it reaches; a read asks this in the same step as it sends, with no await between
  readonly isSessionVisible: (id: SessionID) => boolean;

  readonly findPermissionSession: (request: string) => SessionID | null;

  // The session a spawn under the given session lands under: that session,
  // or its own parent for a sub-session, so a set stays one level deep.
  // Null spawns the session top-level; 'missing' for an unknown session.
  readonly resolveSpawnParent: (id: SessionID) => SessionID | null | 'missing';

  readonly resolveSpawnTarget: (requested: string | undefined) => string;

  readonly requireWorkspaceTarget: (target: string) => void;

  readonly buildDefaultWorkspaceDir: (
    target: string,
    source: Extract<SpawnWorkspaceSource, { kind: 'git' }>,
  ) => string;

  readonly requireAgentTarget: (agent: AgentID, target: string) => void;

  readonly requirePluginDirs: (
    target: string,
    configured: readonly string[],
    requested: readonly string[],
  ) => string[];

  readonly findSource: (id: string) => SourceProvider | null;

  readonly collectAlternateGitURLs: (url: string) => readonly string[];

  readonly checkRepositoryAccess: (
    request: Omit<Parameters<typeof checkRepositoryAccess>[0], 'transports'>,
  ) => ReturnType<typeof checkRepositoryAccess>;

  readonly spawnSession: (
    plan: () => SpawnParams,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
  ) => Promise<DaemonAnswer<'session.spawn'>>;

  readonly killSession: (id: SessionID, stopOnly: boolean) => Promise<KillOutcome>;

  readonly forgetSession: (
    id: SessionID,
    confirmToken: string | undefined,
    refuse: ForgetRefusals,
    caller: SessionID | null,
  ) => Promise<ForgetResult | 'missing'>;

  readonly revokeSessionAuth: (id: SessionID) => Promise<boolean>;

  readonly updateSessionAuth: (id: SessionID) => Promise<AuthRebound | null>;

  readonly updateSession: (
    id: SessionID,
    changes: SessionChanges,
  ) => boolean | 'shared_host' | 'agent_named';

  readonly updateSessionScope: (
    id: SessionID,
    scope: DeclaredScope,
  ) => Promise<PublishedRecord | 'missing'>;

  readonly isCallerTree: (id: SessionID, caller: SessionID) => boolean;
  readonly quitDaemon: () => void;
  readonly announceRestart: (result: RestartResult) => Promise<void>;
  readonly ackSession: (id: SessionID) => boolean;
  readonly planResumeCommand: (id: SessionID) => ResumeCommand;
  readonly readSessionScreen: (id: SessionID) => Promise<ScreenText | 'missing' | 'no_screen'>;

  readonly readSessionMenu: (
    id: SessionID,
  ) => Promise<MenuView | null | 'missing' | 'no_screen' | 'unsupported'>;

  readonly applySessionMenuChoice: (
    id: SessionID,
    choice: MenuChoice,
  ) => Promise<MenuChoiceResult | 'missing' | 'dead' | 'unsupported'>;
  readonly answerPermission: (request: string, decision: string) => AnswerResult;
  readonly restoreFleet: (cols: number, rows: number) => Promise<number>;

  readonly writeStateBackup: (path: string) => Promise<number>;

  readonly pruneWorkspaces: (remove: boolean) => Promise<WorkspacePrune>;
  readonly attachSession: (
    client: OutputClient,
    sessionID: SessionID,
    dims: Dims,
  ) => 'ok' | 'missing' | 'dead';
  readonly watchSession: (
    client: OutputClient,
    sessionID: SessionID,
  ) => Promise<SessionWatch | 'missing' | 'dead'>;
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

  readonly readSessionRecord: (
    id: SessionID,
    access: TargetAccess | null,
  ) => Promise<SessionRecord | 'missing'>;
  readonly loadSessionTranscript: (
    id: SessionID,
    from: TranscriptPosition | null,
    limit: number,
  ) => Promise<SessionTranscriptRead | 'missing' | 'unsupported'>;

  readonly readEvents: (params: ReadEventsParams) => Promise<EventsPage>;

  readonly readNote: (
    id: number,
    access: TargetAccess | null,
  ) => Promise<{ readonly owner: SessionID; readonly view: NoteView } | null>;

  readonly readAnswer: (
    id: number,
    access: TargetAccess | null,
  ) => Promise<{ readonly owner: SessionID; readonly view: AnswerView } | null>;

  readonly writeSessionMessage: (
    params: WriteSessionMessageParams,
  ) => Promise<DaemonAnswer<'session.message'> | MessageRefusal>;
  readonly readMessage: (messageID: MessageID, waitMs: number) => Promise<MessageView | null>;

  readonly attachTap: (
    client: TapClient,
    sessionID: SessionID,
    access: TargetAccess | null,
    notices: boolean,
  ) => 'ok' | 'missing' | 'unsupported';

  readonly detachTap: (client: TapClient, sessionID: SessionID) => void;

  readonly ackMessage: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
    access: TargetAccess | null,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;

  readonly ackNotice: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;
}
