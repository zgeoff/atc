import { buildOptionalString } from '@atc/core/schema';
import { buildClaudeStyleHookEvent, buildNeedsInputEvent } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { z } from 'zod';
import { CLAUDE_HOOKS } from './claude-hooks';

// Claude's hook payload keys, snake_case. An absent or wrong-typed field
// parses to undefined rather than failing the payload, so a broken reporter
// never breaks the session it reports on.
const CLAUDE_HOOK_PAYLOAD_SCHEMA = z.object({
  session_id: buildOptionalString(),
  transcript_path: buildOptionalString(),
  message: buildOptionalString(),
  notification_type: buildOptionalString(),
  last_assistant_message: buildOptionalString(),
  prompt: buildOptionalString(),
});

type ClaudeHookPayload = z.infer<typeof CLAUDE_HOOK_PAYLOAD_SCHEMA>;

export function buildClaudeHookEvent(e: HookEvent): AdapterEvent {
  return buildClaudeStyleHookEvent(e, {
    hooks: CLAUDE_HOOKS,
    parsePayload: (payload) => {
      const parsed = CLAUDE_HOOK_PAYLOAD_SCHEMA.safeParse(payload);

      return parsed.success ? parsed.data : {};
    },
    buildNeedsInput: (base, payload) => ({
      ...buildNeedsInputEvent(base, payload.message),
      ...buildPermissionPending(payload.notification_type),
    }),
    buildSources: (payload: ClaudeHookPayload) =>
      payload.transcript_path === undefined
        ? {}
        : { nameSource: payload.transcript_path, transcriptSource: payload.transcript_path },
  });
}

// A permission prompt waits on a person; an idle notice shows that no prompt
// is open. Any other notice says neither, so it leaves the field out.
function buildPermissionPending(type: string | undefined): { permissionPending?: boolean } {
  if (type === 'permission_prompt') {
    return { permissionPending: true };
  }

  if (type === 'idle_prompt') {
    return { permissionPending: false };
  }

  return {};
}
