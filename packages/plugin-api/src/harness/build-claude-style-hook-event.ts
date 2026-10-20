import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { match } from 'ts-pattern';
import { buildHeartbeatEvent } from './build-heartbeat-event';
import { buildPromptSubmittedEvent } from './build-prompt-submitted-event';
import { buildTurnDoneEvent } from './build-turn-done-event';

export type ClaudeStyleHook =
  | 'SessionStart'
  | 'NeedsInput'
  | 'Stop'
  | 'UserPromptSubmit'
  | 'SessionEnd';

export interface ClaudeStyleHookPayload {
  readonly session_id?: string | undefined;
  readonly prompt?: string | undefined;
  readonly last_assistant_message?: string | undefined;
}

export interface ClaudeStyleHookRules<P extends ClaudeStyleHookPayload> {
  readonly hooks: Readonly<Record<string, ClaudeStyleHook>>;

  // Reads a payload as the harness's fields; a payload that is not one
  // reads as no fields, so a broken reporter never breaks its session.
  readonly parsePayload: (payload: unknown) => P;
  readonly buildNeedsInput: (base: Readonly<AdapterEvent>, payload: P) => AdapterEvent;
  readonly buildSources: (payload: P) => Pick<AdapterEvent, 'nameSource' | 'transcriptSource'>;
}

export function buildClaudeStyleHookEvent<P extends ClaudeStyleHookPayload>(
  hookEvent: HookEvent,
  rules: ClaudeStyleHookRules<P>,
): AdapterEvent {
  const payload = rules.parsePayload(hookEvent.payload);
  const base = buildHeartbeatEvent(payload.session_id);
  const named: AdapterEvent = { ...base, ...rules.buildSources(payload) };
  const hook = findClaudeStyleHook(hookEvent.event, rules.hooks);

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
