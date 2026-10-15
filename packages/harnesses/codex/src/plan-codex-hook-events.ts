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

/**
 * The event one hook line of a Codex session means, and the state the
 * session's next line reads. Codex reports a session start each time the
 * terminal starts, resumes, clears, compacts, or forks a thread, so only a
 * session start moves the session to another thread. A turn of the old
 * thread can still run after the move, and its hook lines report the old
 * thread: such a line means only that the session is alive. Its approval
 * request raises no attention, because the session's state follows the
 * thread the terminal shows, and no later line of the old thread could
 * clear that attention without overwriting the shown thread's state. A
 * line before the first session start is taken as it reads.
 */
export function planCodexHookEvents(e: HookEvent, prev: unknown): CodexHookPlan {
  const parsed = CODEX_HOOK_STATE_SCHEMA.safeParse(prev);
  const state = parsed.success ? parsed.data : undefined;
  const ev = buildCodexHookEvent(e);
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
