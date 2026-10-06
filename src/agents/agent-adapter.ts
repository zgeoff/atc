import type { AdapterEvent } from '../protocol/adapter-event';
import type { DaemonError } from '../protocol/daemon-error';
import type { HookEvent } from '../protocol/hook-event';
import type { AgentID } from '../shared/agent-id';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { AuthProfile } from '../shared/collect-auth-profiles';
import type { GatewayAuth, GatewayConfig } from '../shared/collect-gateways';
import type { SessionID } from '../shared/session-id';

export interface SpawnOptions {
  readonly prompt: string;

  // true opens the agent's own session picker; an agent session id resumes
  // that specific session.
  readonly resume: boolean | AgentSessionID;

  // The model and effort the session runs with; an absent one leaves the
  // agent's configured default in place.
  readonly model?: string;
  readonly effort?: string;
}

/**
 * The per-launch choices a spawn asks for. Model and effort are checked
 * against what the agent advertises; workspace trust requires a verified clone.
 */
export interface SpawnOverrides {
  readonly trustClonedWorkspace?: boolean;
  readonly model?: string;
  readonly effort?: string;
}

export interface SpawnPlan {
  bin: string;
  args: string[];
}

/**
 * Where a session on a remote host finds atc: the atc binary inside the
 * host, null when the host has none, and the folder the session's own
 * files unpack into. `auth` is given when the harness takes its credential
 * from impd's broker: the revision of the host's runtime auth binding it
 * launches under, which keys any settings the agent writes for it, and the
 * placeholder variables the harness holds in place of a credential.
 */
export interface GuestPaths {
  readonly atc: string | null;
  readonly dir: string;
  readonly auth?: { readonly revision: number; readonly env: Readonly<Record<string, string>> };
}

/**
 * The credential an agent takes from impd's broker instead of holding it:
 * its gateway's endpoint and auth selection, and the auth profiles that
 * selection resolves against. `brokerRequired` is true for an agent that
 * starts only behind the broker; false lets it start on a target that
 * reaches no broker under the sign-in that target's host holds.
 */
export interface AuthSelection {
  readonly gateway: Pick<GatewayConfig, 'id' | 'baseURL'> & { readonly auth: GatewayAuth };
  readonly profiles: ReadonlyMap<string, AuthProfile>;
  readonly brokerRequired: boolean;
}

/**
 * One file a guest plan ships: its text, its bytes, or its bytes with the
 * permission bits it unpacks with.
 */
export type GuestFile =
  | string
  | Uint8Array
  | { readonly content: Uint8Array; readonly mode: number };

/**
 * A spawn on a remote host, with the files the harness reads there, keyed
 * by their path inside the session's guest folder, and the variables the
 * harness process starts with, which no variable the harness inherits
 * overrides.
 */
export interface GuestSpawnPlan extends SpawnPlan {
  readonly files: Readonly<Record<string, GuestFile>>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface TranscriptToolUse {
  readonly name: string;
  readonly input: string;
}

export interface TranscriptRow {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly tools: readonly TranscriptToolUse[];

  // Epoch ms from the line's timestamp.
  readonly at: number | null;
}

export interface NameUpdate {
  name: string;
  namedBy?: 'agent';
}

type AttentionJudgment = 'needs-input' | 'working';

/**
 * The universal attention fallback for agents without a hook system: judges
 * the current serialized screen once output quiesces. null means no opinion
 * and the session's state stands.
 */
interface ScreenDetector {
  readonly detectAttention: (screen: string) => AttentionJudgment | null;
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

  // The session's own model and effort, so a headless turn keeps them.
  readonly model?: string;
  readonly effort?: string;

  // Environment variable names the run's process goes without, such as the
  // credential a session's workspace was cloned with.
  readonly withheldEnv?: readonly string[];
}

export interface HeadlessRunEvents {
  readonly onOutput: (text: string) => void;

  // The turn's whole final message.
  readonly onDone: (result: string) => void;
  readonly onNeedsYou: (msg: string) => void;
}

export type HeadlessRunner = (
  opts: HeadlessRunRequest,
  hooks: HeadlessRunEvents,
) => { readonly stop: () => void };

/**
 * How `agents.list` describes an agent. It holds no secret: never an
 * environment value, a credential, a helper command, or a base URL.
 */
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
}

/**
 * A value worth offering for a spawn option, with the provider model it
 * maps to when the config holds that mapping.
 */
interface SpawnOptionExample {
  readonly value: string;
  readonly resolvesTo: string | null;
}

/**
 * Whether the agent's CLI takes one spawn option, and which values it does.
 * `values` holds the closed set a value must come from; null takes any
 * well-formed value. `backendEffect` is `applied` when the CLI applies the
 * value itself and `unverified` when the backend behind the CLI may ignore
 * it; null for an option the agent does not take.
 */
export interface SpawnOptionSpec {
  readonly supported: boolean;
  readonly values: readonly string[] | null;
  readonly examples: readonly SpawnOptionExample[];
  readonly default: string | null;
  readonly backendEffect: 'applied' | 'unverified' | null;
  readonly note: string | null;
}

export interface SpawnOptionSpecs {
  readonly model: SpawnOptionSpec;
  readonly effort: SpawnOptionSpec;
}

/**
 * The input modes the agent's TUI has switched on, as the session's screen
 * model last saw them.
 */
export interface TerminalInputModes {
  // Whether the TUI asked for pasted text to arrive between bracketed paste
  // markers (DEC mode 2004).
  readonly bracketedPaste: boolean;
}

/**
 * Everything specific to one agent CLI: how to spawn it, how to read its
 * hook payloads, where its session names come from, and how to resume a
 * session outside atc. The session core never sees past this interface.
 */
export interface AgentAdapter {
  // What the registry is keyed by, and what a session records. Unique across
  // registered adapters.
  readonly id: AgentID;

  // Runs one headless turn over a session; null means eject is unsupported
  // for this agent.
  readonly headlessRunner: HeadlessRunner | null;

  // The detector stack's screen tier; null when hooks are authoritative.
  readonly screenDetector: ScreenDetector | null;

  // Whether a session under this agent can take inbox messages through a tap;
  // false refuses every message as unsupported.
  readonly takesMessages: boolean;

  // Absent on a stand-in adapter, which `agents.list` reports as not installed.
  readonly profile?: AgentProfile;
  readonly planSpawn: (opts: SpawnOptions) => SpawnPlan;

  // Plans a spawn on a remote host; null when this agent cannot run there,
  // such as one whose instrumentation needs atc on a host without it.
  // Absent: the agent runs there as a local spawn plans it, with no files.
  // A plan for a guest whose `auth` is given that cannot launch behind the
  // broker is null.
  readonly planGuestSpawn?: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;

  // Guest-relative seed files for the exact root of a verified clone.
  // Absent or null means the adapter cannot accept workspace trust.
  readonly planGuestWorkspaceTrust?: (root: string) => Readonly<Record<string, string>> | null;

  // Accepts folder trust for the exact root of a verified clone on the
  // daemon's machine, in the agent's own config, and resolves to a function
  // that takes it back for a launch that fails before the agent starts.
  // Absent means the adapter cannot accept workspace trust there.
  readonly updateLocalWorkspaceTrust?: (root: string) => Promise<() => Promise<void>>;

  // The credential this agent takes from impd's broker, or null when it
  // takes none. Absent: it takes none.
  readonly findAuthSelection?: () => AuthSelection | null;

  // The refusal every start of this agent's harness gets, on any target,
  // or null when it may start. Absent: no start is refused.
  readonly findSpawnRefusal?: () => DaemonError | null;

  // The command that exits 0 inside a remote host when the agent there can
  // sign in without a person. Absent: atc runs no check.
  readonly planAuthCheck?: () => readonly string[];
  readonly normalizeHook: (e: HookEvent) => AdapterEvent;
  readonly loadName: (
    source: string,
    namedBy: 'user' | 'auto' | 'agent',
  ) => Promise<NameUpdate | null>;
  readonly canResume: (session: ResumeCheck) => boolean;
  readonly buildResumeCommand: (
    cwd: string,
    agentSessionID: AgentSessionID | undefined,
  ) => string | null;

  // Turns one line of the agent's transcript file into a conversation row,
  // null for a line that is not one. Absent: atc cannot read this agent's
  // transcript.
  readonly parseTranscriptLine?: (line: string) => TranscriptRow | null;

  // The PTY writes, in order, that type a line into the agent's TUI and
  // submit it. Absent: the line and a trailing newline go as one write.
  readonly planLineInput?: (text: string, modes: TerminalInputModes) => readonly string[];
}
