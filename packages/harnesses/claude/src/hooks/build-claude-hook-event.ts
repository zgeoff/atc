import { buildClaudeStyleHookEvent, buildNeedsInputEvent } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { buildOptionalString } from '@atcx/contract/schema';
import { z } from 'zod';
import { CLAUDE_HOOKS } from './claude-hooks';

const CLAUDE_HOOK_PAYLOAD_SCHEMA = z.object({
  session_id: buildOptionalString(),
  transcript_path: buildOptionalString(),
  message: buildOptionalString(),
  notification_type: buildOptionalString(),
  last_assistant_message: buildOptionalString(),
  prompt: buildOptionalString(),
  error: buildOptionalString(),
  error_details: buildOptionalString(),
});

type ClaudeHookPayload = z.infer<typeof CLAUDE_HOOK_PAYLOAD_SCHEMA>;

export function buildClaudeHookEvent(hookEvent: HookEvent): AdapterEvent {
  return buildClaudeStyleHookEvent(hookEvent, {
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

function buildPermissionPending(type: string | undefined): { permissionPending?: boolean } {
  if (type === 'permission_prompt') {
    return { permissionPending: true };
  }

  if (type === 'idle_prompt') {
    return { permissionPending: false };
  }

  return {};
}
