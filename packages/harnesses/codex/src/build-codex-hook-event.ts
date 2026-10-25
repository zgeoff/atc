import { buildClaudeStyleHookEvent, buildNeedsInputEvent } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { buildOptionalString } from '@atcx/contract/schema';
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

// the session id is the name source, since the session index keys titles by it
export function buildCodexHookEvent(hookEvent: HookEvent): AdapterEvent {
  return buildClaudeStyleHookEvent(hookEvent, {
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
