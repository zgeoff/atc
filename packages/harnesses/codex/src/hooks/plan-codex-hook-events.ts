import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { z } from 'zod';
import { buildCodexHookEvent } from './build-codex-hook-event';

const CODEX_HOOK_STATE_SCHEMA = z.object({ thread: z.string() });

type CodexHookState = z.infer<typeof CODEX_HOOK_STATE_SCHEMA>;

interface CodexHookPlan {
  readonly events: readonly [AdapterEvent];
  readonly next?: CodexHookState;
}

export function planCodexHookEvents(hookEvent: HookEvent, previous: unknown): CodexHookPlan {
  const parsed = CODEX_HOOK_STATE_SCHEMA.safeParse(previous);
  const state = parsed.success ? parsed.data : undefined;
  const ev = buildCodexHookEvent(hookEvent);
  const thread = ev.agentSessionID;

  if (ev.kind === 'started' && thread !== undefined) {
    return { events: [ev], next: { thread } };
  }

  const keep = state === undefined ? {} : { next: state };

  if (state === undefined || thread === undefined || thread === state.thread) {
    return { events: [ev], ...keep };
  }

  return { events: [{ kind: 'heartbeat' }], ...keep };
}
