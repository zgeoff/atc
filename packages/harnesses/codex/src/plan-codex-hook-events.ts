import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { z } from 'zod';
import { buildCodexHookEvent } from './build-codex-hook-event';

// What a Codex session's earlier hook lines leave for its next one: the
// thread the terminal shows, from the latest session start.
const CODEX_HOOK_STATE_SCHEMA = z.object({ thread: z.string() });

type CodexHookState = z.infer<typeof CODEX_HOOK_STATE_SCHEMA>;

interface CodexHookPlan {
  readonly events: readonly [AdapterEvent];
  readonly next?: CodexHookState;
}

// codex reports a session start each time the terminal starts, resumes, clears, compacts or
// forks a thread, so only a session start moves the session to another thread
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

  // a turn of an older thread can still run after a move; its approval request would raise
  // attention no later line of that thread could clear without overwriting the shown thread
  return { events: [{ kind: 'heartbeat' }], ...keep };
}
