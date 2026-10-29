import type { AgentID } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import type { DaemonError } from '@atc/protocol/wire';
import type { AgentSessionID, SessionID, SpawnOptionSpec, TranscriptRow } from '@atcx/contract';
import type { AuthProfile } from './auth-profile';
import type { GatewayAuth } from './gateway-auth';
import type { MessageBridge, MessageBridgeRequest } from './message-bridge';

export interface SpawnOptions {
  readonly prompt: string;

  // true opens the agent's own session picker; an agent session id resumes
  // that specific session.
  readonly resume: boolean | AgentSessionID;

  // The model and effort the session runs with; an absent one leaves the
  // agent's configured default in place.
  readonly model?: string;
  readonly effort?: string;

  // The session's own plugin folders, as absolute paths on the daemon's
  // machine, loaded after the ones the agent's config sets.
  readonly pluginDirs?: readonly string[];

  // Whether a session on a remote host gets an atc MCP server, which reaches
  // the daemon through the session's bridge socket.
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

  // set on top of what the harness process inherits.
  readonly env?: Readonly<Record<string, string>>;

  // the absolute path on the session's host of the folder the session owns
  // as its scratch space; absent for an agent that plans none.
  readonly scratch?: string;
}

export interface GuestPaths {
  // the atc binary inside the host, null when the host has none.
  readonly atc: string | null;

  // the folder the session's own files unpack into.
  readonly directory: string;

  // given when the harness takes its credential from the target's broker.
  readonly auth?: {
    // the revision of the host's runtime auth binding the launch runs under,
    // which keys any settings the agent writes for it.
    readonly revision: number;

    // the placeholder variables the harness holds in place of a credential.
    readonly env: Readonly<Record<string, string>>;
    readonly profileEnv: Readonly<Record<string, string>>;

    // the sign-in state the broker lists for each secret of kind `oauth` in the
    // binding, keyed by the secret's name.
    readonly oauth?: Readonly<Record<string, GuestOAuthState>>;
  };
}

export interface GuestOAuthState {
  readonly status: 'pending' | 'ready' | 'needs_login';

  // the payload of the last ID token, identifiers and never a credential, or
  // null before the broker has one.
  readonly idClaims: Readonly<Record<string, unknown>> | null;
}

export interface AuthSelection {
  readonly gateway: {
    readonly id: AgentID;
    readonly baseURL: string;
    readonly auth: GatewayAuth;
  };
  readonly profiles: ReadonlyMap<string, AuthProfile>;

  // false lets the agent start on a target that reaches no broker, under the
  // sign-in that target's host holds.
  readonly brokerRequired: boolean;
}

export type GuestFile =
  | string
  | Uint8Array
  | { readonly content: Uint8Array; readonly mode: number };

export interface GuestSpawnPlan extends SpawnPlan {
  // keyed by path inside the session's guest folder.
  readonly files: Readonly<Record<string, GuestFile>>;

  // no variable the harness inherits overrides these.
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProjectSettingsCheck {
  // relative to the directory the harness starts in.
  readonly files: readonly string[];

  // relative to that directory, each directory above it, and the main
  // checkout of its git worktree, since the agent reads them at a
  // repository's root.
  readonly rootFiles: readonly string[];

  // takes the file's absolute path on the host; null when the content would
  // not override or route around a sign-in through the target's broker.
  readonly findRefusal: (path: string, content: string) => DaemonError | null;
}

export interface NameUpdate {
  name: string;
  namedBy?: 'agent';
}

// Reads files on the host a session runs on, which for a remote target is
// another machine than the daemon's.
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

  // The atc session the run belongs to.
  readonly sessionID?: SessionID;

  // The session's own model, effort and plugin folders, so a headless turn
  // keeps them.
  readonly model?: string;
  readonly effort?: string;
  readonly pluginDirs?: readonly string[];

  // Environment variable names the run's process goes without, such as the
  // credential a session's workspace was cloned with.
  readonly withheldEnv?: readonly string[];

  // Where the session's published record lies, which the run's process
  // reads from its session environment.
  readonly recordPath?: string;

  // The socket the daemon takes hook reports on, which the run's process
  // reports to from its session environment.
  readonly reporterSocket: string;
}

export interface HeadlessRunEvents {
  readonly onOutput: (text: string) => void;

  // The turn's whole final message.
  readonly onDone: (result: string) => void;
  readonly onNeedsYou: (message: string) => void;
}

// A live headless turn; stop aborts it.
export interface HeadlessRunHandle {
  readonly stop: () => void;
}

export type HeadlessRunner = (
  opts: HeadlessRunRequest,
  events: HeadlessRunEvents,
) => HeadlessRunHandle;

export interface AgentProfile {
  readonly label: string;

  // The family the agent belongs to, chosen by its adapter; agents.list
  // reports it as given, and any string is a valid kind.
  readonly kind: string;

  // The binary a spawn runs: a name looked up on PATH, or a path.
  readonly bin: string;

  // Model names the config sets explicitly, keyed by role; null when it sets none.
  readonly models: Readonly<Record<string, string>> | null;

  // The per-session overrides a spawn can pass this agent's CLI.
  readonly spawnOptions: SpawnOptionSpecs;

  // The plugin folders the config loads into every session of the agent, as
  // absolute paths on the daemon's machine; absent loads none.
  readonly pluginDirs?: readonly string[];
}

export interface SpawnOptionSpecs {
  readonly model: SpawnOptionSpec;
  readonly effort: SpawnOptionSpec;

  // absent for an agent that takes no plugin folders.
  readonly pluginDirs?: SpawnOptionSpec;
}

export interface TerminalInputModes {
  // Whether the TUI asked for pasted text to arrive between bracketed paste
  // markers (DEC mode 2004).
  readonly bracketedPaste: boolean;
}

export interface ScreenMenu {
  // The menu's lines above its options, without the dialog's border.
  readonly text: string;
  readonly options: readonly ScreenMenuOption[];

  // The index into `options` of the option the cursor is on.
  readonly highlighted: number;

  // present when the screen shows only part of a longer list, or may. The
  // list is the boxed options when any has a box; unboxed items after them
  // stay on the screen as it scrolls. Absent: the whole list is on screen.
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

  // Whether the option's box is ticked, or null for an option with no box.
  readonly checked: boolean | null;
}

// the session takes no other input until the line's last step is done.
export type LineInputStep = string | { readonly pauseMs: number };

export interface HookPlan {
  readonly events: readonly AdapterEvent[];

  // opaque to the daemon, which passes it back with this session's next line
  // only. Absent keeps no state.
  readonly next?: unknown;
}

export interface AgentAdapter {
  // What the registry is keyed by, and what a session records. Unique across
  // registered adapters.
  readonly id: AgentID;

  // The agent value this harness's own hook lines carry, which a hook line
  // must match for the session to act on it. Absent: the adapter's id.
  readonly hookAgent?: AgentID;

  // Runs one headless turn over a session; null means eject is unsupported
  // for this agent.
  readonly headlessRunner: HeadlessRunner | null;

  // The detector stack's screen tier; null when hooks are authoritative.
  readonly screenDetector: ScreenDetector | null;

  // Whether a session under this agent can take inbox messages through a tap;
  // false refuses every message as unsupported.
  readonly takesMessages: boolean;

  // Whether a guest plan gives the session an atc MCP server when its spawn
  // options ask for one; absent refuses a spawn that grants atc access.
  readonly takesAtcMCP?: boolean;

  // Starts the daemon-side bridge for a local launch's messages, and resolves
  // once the terminal can start against it. Absent: the session takes its
  // messages through a tap its own processes open, if at all.
  readonly startMessageBridge?: (request: MessageBridgeRequest) => Promise<MessageBridge>;

  // Absent on a stand-in adapter, which `agents.list` reports as not installed.
  readonly profile?: AgentProfile;

  // Plans a spawn on the daemon's machine. With `session`, the session the
  // spawn starts, an agent that gives each session a scratch folder of its
  // own creates it; without one it plans no scratch folder.
  readonly planSpawn: (opts: SpawnOptions, session?: SessionID) => SpawnPlan;

  // Plans a spawn on a remote host; null when this agent cannot run there,
  // or cannot launch behind the broker for a guest whose `auth` is given.
  // Absent: the agent runs there as a local spawn plans it, with no files.
  readonly planGuestSpawn?: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;

  // Absent: the agent reads no file from its home.
  readonly agentHomeLocation?: AgentHomeLocation;

  // The guest-relative files of a remote session's message mod, given the
  // atc inside its host, written again when a running agent drops the mod.
  // Absent: the agent has no such mod.
  readonly planGuestBridgeFiles?: (atc: string) => Readonly<Record<string, string>>;

  // Guest-relative seed files for the exact root of a verified clone.
  // Absent or null means the adapter cannot accept workspace trust.
  readonly planGuestWorkspaceTrust?: (root: string) => Readonly<Record<string, string>> | null;

  // Accepts folder trust for a verified clone's exact root in the agent's own
  // config, resolving to a function that takes it back for a launch that fails
  // before the agent starts. Absent: the adapter cannot accept trust locally.
  readonly updateLocalWorkspaceTrust?: (root: string) => Promise<() => Promise<void>>;

  // The credential this agent takes from the target's broker, or null when it
  // takes none. Absent: it takes none.
  readonly findAuthSelection?: () => AuthSelection | null;

  // The refusal every start of this agent's harness gets, on any target,
  // or null when it may start. Absent: no start is refused.
  readonly findSpawnRefusal?: () => DaemonError | null;

  // The command that exits 0 inside a remote host when the agent there can
  // sign in without a person. Absent: atc runs no check.
  readonly planAuthCheck?: () => readonly string[];

  // The project settings a remote launch behind the target's broker reads in
  // the directory the harness starts in, before it starts. Absent: atc
  // reads none.
  readonly planProjectSettingsCheck?: () => ProjectSettingsCheck;

  // Reads one hook line as the events it means for its session. `prev` is
  // the state this adapter returned for the same session's previous line,
  // or undefined for the session's first line since its harness booted.
  readonly planHookEvents: (hookEvent: HookEvent, previous: unknown, host: SessionHost) => HookPlan;
  readonly loadName: (
    source: string,
    namedBy: 'user' | 'auto' | 'agent',
    host: SessionHost,
  ) => Promise<NameUpdate | null>;
  readonly canResume: (session: ResumeCheck) => boolean;

  // The last argument holds the plugin folders the session's spawn asked for.
  readonly planResumeCommand: (
    cwd: string,
    agentSessionID: AgentSessionID | undefined,
    pluginDirs: readonly string[],
  ) => string | null;

  // Turns one line of the agent's transcript file into a conversation row,
  // null for a line that is not one. Absent: atc cannot read this agent's
  // transcript.
  readonly parseTranscriptLine?: (line: string) => TranscriptRow | null;

  // The PTY writes, in order, that type a line into the agent's TUI and
  // submit it, with any pause the TUI needs between two of them. Absent:
  // the line and a trailing newline go as one write.
  readonly planLineInput?: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  // The menu the TUI waits on, read from the screen text, or null when it
  // shows none. `rows` is the terminal's height, which the trimmed screen
  // text does not show. Absent: atc cannot read this agent's menus.
  readonly findMenu?: (screen: string, rows?: number) => ScreenMenu | null;
}
