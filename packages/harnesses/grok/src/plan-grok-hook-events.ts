import { join } from 'node:path';
import {
  buildHeartbeatEvent,
  buildNeedsInputEvent,
  buildPromptSubmittedEvent,
  buildTurnDoneEvent,
} from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { normalizeHookEventName } from '@atc/protocol/session';
import { buildOptionalString } from '@atcx/contract/schema';
import { match } from 'ts-pattern';
import { z } from 'zod';
import { GROK_HOOKS } from './grok-hooks';
import type { GrokHook } from './grok-hooks';

const GROK_HOOK_PAYLOAD_SCHEMA = z.object({
  sessionId: buildOptionalString(),
  cwd: buildOptionalString(),
  promptId: buildOptionalString(),
  subagentType: buildOptionalString(),
  prompt: buildOptionalString(),
  notificationType: buildOptionalString(),
  message: buildOptionalString(),
  reason: buildOptionalString(),
  lastAssistantMessage: buildOptionalString(),
});

type GrokHookPayload = z.infer<typeof GROK_HOOK_PAYLOAD_SCHEMA>;

const GROK_HOOK_STATE_SCHEMA = z.object({
  latestPromptID: z.string().optional(),
  lastKind: z.enum([
    'started',
    'needs-input',
    'turn-done',
    'prompt-submitted',
    'ended',
    'heartbeat',
  ]),
});

type GrokHookState = z.infer<typeof GROK_HOOK_STATE_SCHEMA>;

interface GrokHookPlan {
  readonly events: readonly [AdapterEvent];
  readonly next?: GrokHookState;
}

export function planGrokHookEvents(
  hookEvent: HookEvent,
  previous: unknown,
  home: string,
): GrokHookPlan {
  const parsed = GROK_HOOK_PAYLOAD_SCHEMA.safeParse(hookEvent.payload);
  const payload: GrokHookPayload = parsed.success ? parsed.data : {};
  const state = GROK_HOOK_STATE_SCHEMA.safeParse(previous).data;
  const hook = findGrokHook(hookEvent.event);
  const subagent = payload.subagentType !== undefined && payload.subagentType !== '';
  const event = buildGrokEvent({ hook, payload, state, home, subagent });

  if (hook === 'SessionEnd' && !subagent) {
    return { events: [event] };
  }

  const promptID = hook === 'UserPromptSubmit' && !subagent ? payload.promptId : undefined;
  const latestPromptID = promptID ?? state?.latestPromptID;

  return {
    events: [event],
    next: {
      lastKind: isStateKind(event.kind) ? event.kind : (state?.lastKind ?? event.kind),
      ...(latestPromptID === undefined ? {} : { latestPromptID }),
    },
  };
}

function findGrokHook(event: string): GrokHook | null {
  const name = normalizeHookEventName(event);

  return GROK_HOOKS.find((hook) => hook === name) ?? null;
}

interface BuildGrokEventOptions {
  readonly hook: GrokHook | null;
  readonly payload: GrokHookPayload;
  readonly state: GrokHookState | undefined;
  readonly home: string;
  readonly subagent: boolean;
}

function buildGrokEvent(options: BuildGrokEventOptions): AdapterEvent {
  const base = buildHeartbeatEvent(options.payload.sessionId);

  const named: AdapterEvent = {
    ...base,
    ...(options.payload.sessionId === undefined || options.payload.cwd === undefined
      ? {}
      : {
          nameSource: buildGrokNameSource(
            options.home,
            options.payload.sessionId,
            options.payload.cwd,
          ),
        }),
  };

  if (options.hook === null || options.subagent) {
    return base;
  }

  const stale =
    options.payload.promptId !== undefined &&
    options.state?.latestPromptID !== undefined &&
    options.payload.promptId !== options.state.latestPromptID;

  return match(options.hook)
    .with('SessionStart', (): AdapterEvent => ({ ...named, kind: 'started' }))
    .with('UserPromptSubmit', () => buildPromptSubmittedEvent(named, options.payload.prompt))
    .with('Notification', () => buildNotificationEvent(base, named, options.payload, options.state))
    .with('Stop', () =>
      options.payload.reason !== 'end_turn' || stale
        ? base
        : buildTurnDoneEvent(named, options.payload.lastAssistantMessage),
    )
    .with('StopFailure', 'StopCancelled', () =>
      stale ? base : buildTurnDoneEvent(named, options.payload.lastAssistantMessage),
    )
    .with('SessionEnd', (): AdapterEvent => ({ ...base, kind: 'ended' }))
    .exhaustive();
}

function buildGrokNameSource(home: string, sessionID: string, cwd: string): string {
  return join(home, 'sessions', encodeURIComponent(cwd), sessionID, 'summary.json');
}

function buildNotificationEvent(
  base: Readonly<AdapterEvent>,
  named: Readonly<AdapterEvent>,
  payload: GrokHookPayload,
  state: GrokHookState | undefined,
): AdapterEvent {
  return match(payload.notificationType)
    .with('permission_prompt', () => buildNeedsInputEvent(base, payload.message))
    .with('idle_prompt', (): AdapterEvent => ({
      ...named,
      kind: state?.lastKind === 'needs-input' ? 'heartbeat' : 'turn-done',
    }))
    .otherwise(() => ({ ...base }));
}

function isStateKind(kind: AdapterEvent['kind']): boolean {
  return kind === 'needs-input' || kind === 'prompt-submitted' || kind === 'turn-done';
}
