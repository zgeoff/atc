import type { HookEvent } from './hooks';

export type AgentKind = 'claude' | 'grok' | 'codex';

/**
 * Missing, empty, and unknown values become Claude so a fleet written
 * before the agent column still restores as Claude.
 */
export function toAgentKind(raw: unknown): AgentKind {
  return raw === 'grok' || raw === 'codex' ? raw : 'claude';
}

/**
 * Strict counterpart to toAgentKind: an unrecognised value is null, never
 * silently coerced to Claude, for call sites that must reject rather than
 * guess.
 */
export function parseAgentKind(raw: unknown): AgentKind | null {
  return raw === 'claude' || raw === 'grok' || raw === 'codex' ? raw : null;
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
  readonly kind: AgentKind;

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
