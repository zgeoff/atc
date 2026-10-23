import { join } from 'node:path';
import { buildOptionalString } from '@atc/core/schema';
import {
  buildHeartbeatEvent,
  buildNeedsInputEvent,
  buildPromptSubmittedEvent,
  buildTurnDoneEvent,
} from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { normalizeHookEventName } from '@atc/protocol/session';
import { match } from 'ts-pattern';
import { z } from 'zod';
import { GROK_HOOKS } from './grok-hooks';
import type { GrokHook } from './grok-hooks';

// Grok's hook payload keys, camelCase. An absent or wrong-typed field parses
// to undefined rather than failing the payload, so a broken reporter never
// breaks the session it reports on.
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

// What a Grok session's earlier hook lines leave for its next one: the id
// of the latest prompt a person submitted, and the kind of the last event
// that changed the session's state.
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

// three rules need the previous line's state: a stop for a prompt older than the latest is stale,
// an idle notice right after a permission prompt shows nothing finished, and a subagent's line
// is only a heartbeat for its session
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

  // A session's own prompt submit records its prompt as the latest; every
  // other line keeps the one before it.
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

// A permission prompt waits on a person. An idle notice right after one
// shows only that the prompt is still open; any other idle notice means the
// turn finished.
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

// The kinds that change what a session waits on, which a later idle notice
// reads.
function isStateKind(kind: AdapterEvent['kind']): boolean {
  return kind === 'needs-input' || kind === 'prompt-submitted' || kind === 'turn-done';
}
