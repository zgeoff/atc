import type { HookEvent } from '../daemon/hooks';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { SessionID } from '../shared/session-id';

/**
 * Which agent a session runs under: the key the adapter registry is looked
 * up by. Every agent CLI supplies one, and so does every configured backend
 * that drives a CLI it does not own, so two ids can share one kind.
 */
export type AgentID = string;

/**
 * Missing and empty values become Claude so a fleet written before the agent
 * column still restores as Claude. Any other string is returned as it stands,
 * registered or not: an id whose adapter is gone must reach the caller intact
 * so the session can be shown and refused, never quietly run as Claude.
 */
export function toAgentID(raw: unknown): AgentID {
  return typeof raw === 'string' && raw !== '' ? raw : 'claude';
}

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
 * The per-session model and effort a spawn asks for, already checked
 * against what the agent advertises.
 */
export interface SpawnOverrides {
  readonly model?: string;
  readonly effort?: string;
}

export interface SpawnPlan {
  bin: string;
  args: string[];
}

export interface AdapterEvent {
  kind: 'started' | 'needs-input' | 'turn-done' | 'prompt-submitted' | 'ended' | 'heartbeat';
  agentSessionID?: AgentSessionID;
  message?: string;

  // Fuller activity text than message: what the agent last said or was
  // asked, for briefing. Bounded by the adapter.
  detail?: string;

  // Opaque handle the adapter can later pull a session name from.
  nameSource?: string;

  // Claude resume-existence path. Distinct from nameSource: a naming
  // handle is not a resume gate.
  transcriptSource?: string;

  // The agent's whole final message for a finished turn; detail holds a bounded preview of it.
  result?: string;
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
}
