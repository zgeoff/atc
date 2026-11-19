import type { AgentID } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import type { DaemonError } from '@atc/protocol/wire';
import type { AgentSessionID, SessionID, SpawnOptionSpec, TranscriptRow } from '@atcx/contract';
import type { AuthProfile } from './credentials/auth-profile';
import type { GatewayAuth } from './credentials/gateway-auth';
import type { MessageBridge, MessageBridgeRequest } from './plugin/message-bridge';

export interface SpawnOptions {
  readonly prompt: string;

  readonly resume: boolean | AgentSessionID;

  readonly model?: string;
  readonly effort?: string;

  readonly pluginDirs?: readonly string[];

  readonly atcMCP?: boolean;
}

export interface SpawnOverrides {
  readonly trustClonedWorkspace?: boolean;
  readonly model?: string;
  readonly effort?: string;
  readonly pluginDirs?: readonly string[];
}

export interface SpawnPlan {
  bin: string;
  args: string[];

  readonly env?: Readonly<Record<string, string>>;

  readonly scratch?: string;
}

export interface GuestPaths {
  readonly atc: string | null;

  readonly directory: string;

  readonly sessionEnv?: Readonly<Record<string, string>>;

  readonly auth?: {
    readonly revision: number;

    readonly env: Readonly<Record<string, string>>;
    readonly profileEnv: Readonly<Record<string, string>>;

    readonly telemetryHost?: string;

    readonly oauth?: Readonly<Record<string, GuestOAuthState>>;

    readonly routes?: Readonly<Record<string, string>>;
  };

  readonly signIn?: { readonly directory: string };
}

export interface GuestOAuthState {
  readonly status: 'pending' | 'ready' | 'needs_login';

  readonly idClaims: Readonly<Record<string, unknown>> | null;
}

export interface AuthSelection {
  readonly gateway: {
    readonly id: AgentID;
    readonly baseURL: string;
    readonly auth: GatewayAuth;
  };
  readonly profiles: ReadonlyMap<string, AuthProfile>;

  readonly brokerRequired: boolean;
}

export type GuestFile =
  | string
  | Uint8Array
  | { readonly content: Uint8Array; readonly mode: number };

export interface GuestSpawnPlan extends SpawnPlan {
  readonly files: Readonly<Record<string, GuestFile>>;

  readonly env?: Readonly<Record<string, string>>;
}

export interface ProjectSettingsCheck {
  readonly files: readonly string[];

  // Paths relative to that directory, each directory above it, and the main checkout
  // of its git worktree, because the agent reads these files at a repository's root.
  readonly rootFiles: readonly string[];

  readonly findRefusal: (path: string, content: string) => DaemonError | null;
}

export interface NameUpdate {
  name: string;
  namedBy?: 'agent';
}

export interface HostFiles {
  readonly readMatchingLines: (path: string, pattern: string) => Promise<readonly string[] | null>;

  // ls prints one name per line, so a name that holds a newline reads as two.
  readonly readDirectory: (path: string) => Promise<readonly string[] | null>;
}

export interface SessionHost {
  readonly files: HostFiles;
  readonly agentHome: string | null;
}

export interface AgentHomeLocation {
  readonly env: string;
  readonly folder: string;
}

type AttentionJudgment = 'needs-input' | 'working';

interface ScreenDetector {
  readonly detectAttention: (screen: string) => AttentionJudgment | null;
  readonly untilAgentStart: boolean;
}

export interface ResumeCheck {
  readonly agentSessionID?: AgentSessionID;
  readonly transcriptSource?: string;
}

export interface HeadlessRunRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly resume?: AgentSessionID;

  readonly sessionID?: SessionID;

  readonly model?: string;
  readonly effort?: string;
  readonly pluginDirs?: readonly string[];

  readonly withheldEnv?: readonly string[];

  readonly recordPath?: string;

  readonly reporterSocket: string;
}

export interface HeadlessRunEvents {
  readonly onOutput: (text: string) => void;

  readonly onDone: (result: string) => void;
  readonly onNeedsYou: (message: string) => void;
}

export interface HeadlessRunHandle {
  readonly stop: () => void;
}

export type HeadlessRunner = (
  opts: HeadlessRunRequest,
  events: HeadlessRunEvents,
) => HeadlessRunHandle;

export interface AgentProfile {
  readonly label: string;

  readonly kind: string;

  readonly bin: string;

  readonly models: Readonly<Record<string, string>> | null;

  readonly spawnOptions: SpawnOptionSpecs;

  readonly pluginDirs?: readonly string[];
}

export interface SpawnOptionSpecs {
  readonly model: SpawnOptionSpec;
  readonly effort: SpawnOptionSpec;

  readonly pluginDirs?: SpawnOptionSpec;
}

export interface TerminalInputModes {
  readonly bracketedPaste: boolean;
}

export interface ScreenMenu {
  readonly text: string;
  readonly options: readonly ScreenMenuOption[];

  readonly highlighted: number;

  readonly scroll?: ScreenMenuScroll;
}

export interface ScreenMenuScroll {
  // whether a mark beside the rows shows options above them, and below. A
  // list hides its mark on the cursor's row, so both false means the list
  // fills its window with the cursor on a row that could hide a mark.
  readonly above: boolean;
  readonly below: boolean;
}

export interface ScreenMenuOption {
  readonly label: string;

  readonly checked: boolean | null;
}

export type LineInputStep = string | { readonly pauseMs: number };

export interface HookPlan {
  readonly events: readonly AdapterEvent[];

  readonly next?: unknown;
}

export interface AgentAdapter {
  readonly id: AgentID;

  readonly hookAgent?: AgentID;

  readonly headlessRunner: HeadlessRunner | null;

  readonly screenDetector: ScreenDetector | null;

  readonly takesMessages: boolean;

  readonly takesAtcMCP?: boolean;

  readonly startMessageBridge?: (request: MessageBridgeRequest) => Promise<MessageBridge>;

  readonly profile?: AgentProfile;

  readonly planSpawn: (opts: SpawnOptions, session?: SessionID) => SpawnPlan;

  readonly planGuestSpawn?: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;

  readonly agentHomeLocation?: AgentHomeLocation;

  readonly planGuestBridgeFiles?: (
    atc: string,
    writtenAt: number,
  ) => Readonly<Record<string, string>>;

  readonly planGuestWorkspaceTrust?: (
    root: string,
    guestDirectory: string,
  ) => Readonly<Record<string, string>> | null;

  readonly trustLocalScratch?: (scratch: string) => Promise<void>;

  readonly updateLocalWorkspaceTrust?: (root: string) => Promise<() => Promise<void>>;

  readonly findAuthSelection?: () => AuthSelection | null;

  readonly findGuestEnvConflict?: (kind: 'broker' | 'routed' | 'stored-token') => string | null;

  readonly signInFile?: string;

  readonly findSpawnRefusal?: () => DaemonError | null;

  readonly planAuthCheck?: () => readonly string[];

  readonly planProjectSettingsCheck?: () => ProjectSettingsCheck;

  readonly planHookEvents: (hookEvent: HookEvent, previous: unknown, host: SessionHost) => HookPlan;
  readonly loadName: (
    source: string,
    namedBy: 'user' | 'auto' | 'agent',
    host: SessionHost,
  ) => Promise<NameUpdate | null>;
  readonly canResume: (session: ResumeCheck) => boolean;

  readonly planResumeCommand: (
    cwd: string,
    agentSessionID: AgentSessionID | undefined,
    pluginDirs: readonly string[],
  ) => string | null;

  readonly parseTranscriptLine?: (line: string) => TranscriptRow | null;

  readonly planLineInput?: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  readonly findMenu?: (screen: string, rows?: number) => ScreenMenu | null;
}
