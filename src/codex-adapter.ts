import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AdapterEvent,
  AgentAdapter,
  AgentKind,
  NameUpdate,
  ResumeCheck,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import type { Config } from './config';
import type { HookEvent } from './hooks';
import { isRecord } from './report';

/**
 * The Codex CLI adapter: spawn arguments, hook payload mapping, resume
 * semantics, and session_index.jsonl name-pulling. Hooks are a user-installed
 * entry in the Codex hook config (`atc codex-hooks` prints it) that the user
 * trusts once in the Codex TUI; atc never writes into the user's Codex config.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';

  readonly kind: AgentKind = 'codex';

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
    const sessionID = e.payload['session_id'];
    const transcript = e.payload['transcript_path'];

    const base: AdapterEvent = {
      kind: 'heartbeat',
      ...(typeof sessionID === 'string' ? { agentSessionID: sessionID } : {}),
    };

    const named: AdapterEvent = {
      ...base,
      ...(typeof sessionID === 'string' ? { nameSource: sessionID } : {}),
      ...(typeof transcript === 'string' ? { transcriptSource: transcript } : {}),
    };

    switch (e.event) {
      case 'SessionStart': {
        return { ...named, kind: 'started' };
      }
      case 'PermissionRequest': {
        const toolName = e.payload['tool_name'];

        const message =
          typeof toolName === 'string' && toolName !== ''
            ? `waiting for approval: ${toolName}`
            : 'waiting for approval';

        return { ...base, kind: 'needs-input', message, detail: message };
      }
      case 'UserPromptSubmit': {
        const prompt = e.payload['prompt'];
        const preview = typeof prompt === 'string' ? prompt.slice(0, 80) : '';

        return {
          ...named,
          kind: 'prompt-submitted',
          ...(preview === '' ? {} : { message: preview, detail: truncateDetail(preview) }),
        };
      }
      case 'Stop': {
        const lastMessage = e.payload['last_assistant_message'];

        return {
          ...named,
          kind: 'turn-done',
          ...(typeof lastMessage === 'string' && lastMessage !== ''
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

    const index = join(resolveCodexHome(), 'session_index.jsonl');
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
  buildResumeCommand(cwd: string, agentSessionID: string | undefined): string | null {
    const resume = agentSessionID === undefined ? 'codex resume' : `codex resume ${agentSessionID}`;
    const quoted = cwd.replaceAll("'", String.raw`'\''`);

    return `cd '${quoted}' && ${resume}`;
  }
}

function resolveCodexHome(): string {
  const home = process.env['CODEX_HOME'];

  return home !== undefined && home !== '' ? home : join(homedir(), '.codex');
}

function truncateDetail(text: string): string {
  return text.length <= 600 ? text : `${text.slice(0, 599)}…`;
}
