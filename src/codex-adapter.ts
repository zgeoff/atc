import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  AdapterEvent,
  AgentAdapter,
  NameUpdate,
  ResumeCheck,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import type { AgentSessionID } from './agent-session-id';
import type { Config } from './config';
import type { HookEvent } from './hooks';
import { isRecord } from './report';
import { resolveAgentHome } from './resolve-agent-home';
import { toShellArg } from './to-shell-arg';
import { truncateDetail } from './truncate-detail';

// Codex's hook payload keys, snake_case. Every field is read once at the top
// of normalizeHook instead of indexing the raw payload throughout; an absent
// or wrong-typed field parses to undefined rather than failing the payload.
const CODEX_HOOK_PAYLOAD_SCHEMA = z.object({
  session_id: buildOptionalString(),
  transcript_path: buildOptionalString(),
  prompt: buildOptionalString(),
  last_assistant_message: buildOptionalString(),
  tool_name: buildOptionalString(),
});

type CodexHookPayload = z.infer<typeof CODEX_HOOK_PAYLOAD_SCHEMA>;

/**
 * The Codex CLI adapter: spawn arguments, hook payload mapping, resume
 * semantics, and session_index.jsonl name-pulling. Hooks are a user-installed
 * entry in the Codex hook config (`atc codex-hooks` prints it) that the user
 * trusts once in the Codex TUI; atc never writes into the user's Codex config.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';

  // Codex has no headless handoff.
  readonly headlessRunner = null;

  // Codex's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    return {
      bin: this.config.codexBin,
      args: [
        ...this.config.codexArgs,

        // Bare resume opens Codex's own session picker; an id resumes that
        // session directly. Both accept a prompt afterwards.
        ...(opts.resume === true ? ['resume'] : []),
        ...(typeof opts.resume === 'string' ? ['resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  normalizeHook(e: HookEvent): AdapterEvent {
    const parsed = CODEX_HOOK_PAYLOAD_SCHEMA.safeParse(e.payload);
    const payload: CodexHookPayload = parsed.success ? parsed.data : {};

    const base: AdapterEvent = {
      kind: 'heartbeat',
      ...(payload.session_id === undefined
        ? {}
        : // oxlint-disable-next-line no-unsafe-type-assertion -- the hook payload's session_id is an agent session id by contract; this is the one point where it is trusted
          { agentSessionID: payload.session_id as AgentSessionID }),
    };

    const named: AdapterEvent = {
      ...base,
      ...(payload.session_id === undefined ? {} : { nameSource: payload.session_id }),
      ...(payload.transcript_path === undefined
        ? {}
        : { transcriptSource: payload.transcript_path }),
    };

    switch (e.event) {
      case 'SessionStart': {
        return { ...named, kind: 'started' };
      }
      case 'PermissionRequest': {
        const toolName = payload.tool_name;

        const message =
          toolName !== undefined && toolName !== ''
            ? `waiting for approval: ${toolName}`
            : 'waiting for approval';

        return { ...base, kind: 'needs-input', message, detail: message };
      }
      case 'UserPromptSubmit': {
        const preview = payload.prompt === undefined ? '' : payload.prompt.slice(0, 80);

        return {
          ...named,
          kind: 'prompt-submitted',
          ...(preview === '' ? {} : { message: preview, detail: truncateDetail(preview) }),
        };
      }
      case 'Stop': {
        const lastMessage = payload.last_assistant_message;

        return {
          ...named,
          kind: 'turn-done',
          ...(lastMessage !== undefined && lastMessage !== ''
            ? { detail: truncateDetail(lastMessage) }
            : {}),
        };
      }
      case 'SessionEnd': {
        return { ...base, kind: 'ended' };
      }
      default: {
        return base;
      }
    }
  }

  // Codex records session titles in session_index.jsonl; the index does not
  // say whether a title was set by /rename or auto-generated, so a title
  // never overrides a user-typed name.
  loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    if (namedBy === 'user') {
      return Promise.resolve(null);
    }

    const index = join(resolveAgentHome('CODEX_HOME', '.codex'), 'session_index.jsonl');
    let text: string;

    try {
      text = readFileSync(index, 'utf8');
    } catch {
      return Promise.resolve(null);
    }

    let name: string | undefined;

    for (const line of text.split('\n')) {
      if (line.trim() === '' || !line.includes(source)) {
        continue;
      }

      try {
        const parsed: unknown = JSON.parse(line);

        if (
          isRecord(parsed) &&
          parsed['id'] === source &&
          typeof parsed['thread_name'] === 'string'
        ) {
          name = parsed['thread_name'];
        }
      } catch {}
    }

    const update = name === undefined || name === '' ? null : { name };

    return Promise.resolve(update);
  }

  canResume(session: ResumeCheck): boolean {
    if (session.transcriptSource === undefined) {
      return true;
    }

    return existsSync(session.transcriptSource);
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    const resume = agentSessionID === undefined ? 'codex resume' : `codex resume ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && ${resume}`;
  }
}

function buildOptionalString() {
  return z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().optional());
}
