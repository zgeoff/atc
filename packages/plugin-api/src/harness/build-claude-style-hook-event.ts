import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { match } from 'ts-pattern';
import { buildHeartbeatEvent } from './build-heartbeat-event';
import { buildNeedsInputEvent } from './build-needs-input-event';
import { buildPromptSubmittedEvent } from './build-prompt-submitted-event';
import { buildTurnDoneEvent } from './build-turn-done-event';

export type ClaudeStyleHook =
  | 'SessionStart'
  | 'NeedsInput'
  | 'Stop'
  | 'TurnFailed'
  | 'UserPromptSubmit'
  | 'SessionEnd';

export interface ClaudeStyleHookPayload {
  readonly session_id?: string | undefined;
  readonly prompt?: string | undefined;
  readonly last_assistant_message?: string | undefined;
  readonly error?: string | undefined;
  readonly error_details?: string | undefined;
}

export interface ClaudeStyleHookRules<P extends ClaudeStyleHookPayload> {
  readonly hooks: Readonly<Record<string, ClaudeStyleHook>>;

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
    .with('TurnFailed', () => ({
      ...buildNeedsInputEvent(named, pickTurnFailureMessage(payload)),
      permissionPending: false,
      turnFailed: true,
    }))
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

function pickTurnFailureMessage(payload: ClaudeStyleHookPayload): string | undefined {
  return [payload.last_assistant_message, payload.error_details, payload.error].find(
    (text) => text !== undefined && text.trim() !== '',
  );
}
