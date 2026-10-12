import { buildOptionalString } from '@atc/core/build-optional-string';
import { buildClaudeStyleHookEvent } from '@atc/plugin-api/harness/build-claude-style-hook-event';
import { buildNeedsInputEvent } from '@atc/plugin-api/harness/build-needs-input-event';
import type { AdapterEvent } from '@atc/protocol/adapter-event';
import type { HookEvent } from '@atc/protocol/hook-event';
import { z } from 'zod';
import { CODEX_HOOKS } from './codex-hooks';

// Codex's hook payload keys, snake_case. An absent or wrong-typed field
// parses to undefined rather than failing the payload, so a broken reporter
// never breaks the session it reports on.
const CODEX_HOOK_PAYLOAD_SCHEMA = z.object({
  session_id: buildOptionalString(),
  transcript_path: buildOptionalString(),
  prompt: buildOptionalString(),
  last_assistant_message: buildOptionalString(),
  tool_name: buildOptionalString(),
});

type CodexHookPayload = z.infer<typeof CODEX_HOOK_PAYLOAD_SCHEMA>;

/**
 * The event one hook line of a Codex session means. A permission request
 * is a needs-input event that holds the tool awaiting approval. The
 * session id is the session's name source, since the session index keys
 * titles by it, and the rollout path is its transcript.
 */
export function buildCodexHookEvent(e: HookEvent): AdapterEvent {
  return buildClaudeStyleHookEvent(e, {
    hooks: CODEX_HOOKS,
    parsePayload: (payload) => {
      const parsed = CODEX_HOOK_PAYLOAD_SCHEMA.safeParse(payload);

      return parsed.success ? parsed.data : {};
    },
    buildNeedsInput: (base, payload) => {
      const message =
        payload.tool_name === undefined || payload.tool_name === ''
          ? 'waiting for approval'
          : `waiting for approval: ${payload.tool_name}`;

      return buildNeedsInputEvent(base, message);
    },
    buildSources: (payload: CodexHookPayload) => ({
      ...(payload.session_id === undefined ? {} : { nameSource: payload.session_id }),
      ...(payload.transcript_path === undefined
        ? {}
        : { transcriptSource: payload.transcript_path }),
    }),
  });
}
