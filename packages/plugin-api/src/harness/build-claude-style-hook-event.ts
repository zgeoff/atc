import type { AdapterEvent } from '@atc/protocol/adapter-event';
import type { HookEvent } from '@atc/protocol/hook-event';
import { match } from 'ts-pattern';
import { buildHeartbeatEvent } from './build-heartbeat-event';
import { buildPromptSubmittedEvent } from './build-prompt-submitted-event';
import { buildTurnDoneEvent } from './build-turn-done-event';

/**
 * What one hook event of a Claude-shaped harness means: its session
 * started, it waits on a person, it finished a turn, a person submitted a
 * prompt, or its session ended.
 */
export type ClaudeStyleHook =
  | 'SessionStart'
  | 'NeedsInput'
  | 'Stop'
  | 'UserPromptSubmit'
  | 'SessionEnd';

/**
 * The payload fields every Claude-shaped harness's hook lines hold, each
 * absent when the line held none of its type.
 */
export interface ClaudeStyleHookPayload {
  readonly session_id?: string | undefined;
  readonly prompt?: string | undefined;
  readonly last_assistant_message?: string | undefined;
}

/**
 * How one Claude-shaped harness differs from the rest: the hook events it
 * registers, each with what it means, how it reads a payload, what its
 * needs-input event holds, and where its session's name and transcript
 * come from.
 */
export interface ClaudeStyleHookRules<P extends ClaudeStyleHookPayload> {
  readonly hooks: Readonly<Record<string, ClaudeStyleHook>>;

  // Reads a payload as the harness's fields; a payload that is not one
  // reads as no fields, so a broken reporter never breaks its session.
  readonly parsePayload: (payload: unknown) => P;
  readonly buildNeedsInput: (base: Readonly<AdapterEvent>, payload: P) => AdapterEvent;
  readonly buildSources: (payload: P) => Pick<AdapterEvent, 'nameSource' | 'transcriptSource'>;
}

/**
 * The event one hook line of a Claude-shaped harness means for its
 * session. A line whose event the harness does not register is a
 * heartbeat. The session start, a finished turn and a submitted prompt
 * carry the session's name and transcript sources; the rest carry only
 * the agent's session id.
 */
export function buildClaudeStyleHookEvent<P extends ClaudeStyleHookPayload>(
  e: HookEvent,
  rules: ClaudeStyleHookRules<P>,
): AdapterEvent {
  const payload = rules.parsePayload(e.payload);
  const base = buildHeartbeatEvent(payload.session_id);
  const named: AdapterEvent = { ...base, ...rules.buildSources(payload) };
  const hook = findClaudeStyleHook(e.event, rules.hooks);

  if (hook === null) {
    return base;
  }

  return match(hook)
    .with('SessionStart', (): AdapterEvent => ({ ...named, kind: 'started' }))
    .with('NeedsInput', () => rules.buildNeedsInput(base, payload))
    .with('Stop', () => buildTurnDoneEvent(named, payload.last_assistant_message))
    .with('UserPromptSubmit', () => buildPromptSubmittedEvent(named, payload.prompt))
    .with('SessionEnd', (): AdapterEvent => ({ ...base, kind: 'ended' }))
    .exhaustive();
}

function findClaudeStyleHook(
  event: string,
  hooks: Readonly<Record<string, ClaudeStyleHook>>,
): ClaudeStyleHook | null {
  return Object.entries(hooks).find(([name]) => name === event)?.[1] ?? null;
}
