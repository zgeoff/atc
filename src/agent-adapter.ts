import type { HookEvent } from './hooks';

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

  // true opens the agent's own session picker; a string resumes that
  // specific agent session id.
  readonly resume: boolean | string;
}

export interface SpawnPlan {
  bin: string;
  args: string[];
}

export interface AdapterEvent {
  kind: 'started' | 'needs-input' | 'turn-done' | 'prompt-submitted' | 'ended' | 'heartbeat';
  agentSessionID?: string;
  message?: string;

  // Fuller activity text than message: what the agent last said or was
  // asked, for briefing. Bounded by the adapter.
  detail?: string;

  // Opaque handle the adapter can later pull a session name from.
  nameSource?: string;

  // Claude resume-existence path. Distinct from nameSource: a naming
  // handle is not a resume gate.
  transcriptSource?: string;
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
  readonly agentSessionID?: string;
  readonly transcriptSource?: string;
}

interface HeadlessRunRequest {
  readonly cwd: string;
  readonly prompt: string;
  readonly resume?: string;
  readonly permissionMode?: string;

  // Settings file the run's CLI is started with, so a headless turn reaches
  // the same backend the session's terminal did.
  readonly settings?: string;
}

interface HeadlessRunEvents {
  readonly onOutput: (text: string) => void;
  readonly onDone: (summary: string) => void;
  readonly onNeedsYou: (msg: string) => void;
}

export type HeadlessRunner = (
  opts: HeadlessRunRequest,
  hooks: HeadlessRunEvents,
) => { readonly stop: () => void };

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
  readonly planSpawn: (opts: SpawnOptions) => SpawnPlan;
  readonly normalizeHook: (e: HookEvent) => AdapterEvent;
  readonly loadName: (
    source: string,
    namedBy: 'user' | 'auto' | 'agent',
  ) => Promise<NameUpdate | null>;
  readonly canResume: (session: ResumeCheck) => boolean;
  readonly buildResumeCommand: (cwd: string, agentSessionID: string | undefined) => string | null;
}
