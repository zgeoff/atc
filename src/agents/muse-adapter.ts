import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { HookEvent } from '../daemon/hooks';
import type { AgentSessionID } from '../shared/agent-session-id';
import { buildOptionalString } from '../shared/build-optional-string';
import type { Config } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toShellArg } from '../shared/to-shell-arg';
import type {
  AdapterEvent,
  AgentAdapter,
  NameUpdate,
  ResumeCheck,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import { resolveMuseDataHome } from './resolve-muse-data-home';
import { truncateDetail } from './truncate-detail';

// Muse's hook payload keys, snake_case — the same spelling Claude uses, so
// hook-report forwards them without translation. An absent or wrong-typed
// field parses to undefined rather than failing the payload, so a broken
// reporter never breaks the session it reports on.
const MUSE_HOOK_PAYLOAD_SCHEMA = z.object({
  session_id: buildOptionalString(),
  prompt: buildOptionalString(),
  last_assistant_message: buildOptionalString(),
  message: buildOptionalString(),
  tool_name: buildOptionalString(),
});

type MuseHookPayload = z.infer<typeof MUSE_HOOK_PAYLOAD_SCHEMA>;

// What Muse writes into `title` before a session's first prompt lands.
const PLACEHOLDER_TITLE = 'New session';

/**
 * The Muse Code adapter: spawn arguments, hook payload mapping, resume
 * semantics, and session-index name-pulling. Hooks are a user-installed
 * entry in `$XDG_CONFIG_HOME/muse/settings.json` (`atc muse-hooks` prints
 * it); Muse has no per-spawn settings flag, so atc never writes that path.
 */
export class MuseAdapter implements AgentAdapter {
  readonly id = 'muse';

  // Muse has no headless handoff: `muse exec` starts a new session rather
  // than taking a turn over an existing one.
  readonly headlessRunner = null;

  // Muse's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    return {
      bin: this.config.museBin,
      args: [
        ...this.config.museArgs,

        // Bare resume opens Muse's own session picker; an id resumes that
        // session directly.
        ...(opts.resume === true ? ['resume'] : []),
        ...(typeof opts.resume === 'string' ? ['resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  normalizeHook(e: HookEvent): AdapterEvent {
    const parsed = MUSE_HOOK_PAYLOAD_SCHEMA.safeParse(e.payload);
    const payload: MuseHookPayload = parsed.success ? parsed.data : {};

    const base: AdapterEvent = {
      kind: 'heartbeat',
      ...(payload.session_id === undefined
        ? {}
        : { agentSessionID: toAgentSessionID(payload.session_id) }),
    };

    // Muse reports transcript_path as null on every event, so the session id
    // is the only naming handle. It is not a resume gate: transcriptSource
    // stays unset and canResume judges the id alone.
    const named: AdapterEvent = {
      ...base,
      ...(payload.session_id === undefined ? {} : { nameSource: payload.session_id }),
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
      case 'Notification': {
        const message = payload.message;

        return {
          ...base,
          kind: 'needs-input',
          ...(message !== undefined && message !== ''
            ? { message, detail: truncateDetail(message) }
            : {}),
        };
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

  // Muse records both an auto title and a generated handle in its session
  // index, and neither records whether a title was user-typed, so a title
  // never overrides a user-typed name.
  loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    if (namedBy === 'user') {
      return Promise.resolve(null);
    }

    const row = readSessionIndexRow(source);

    if (row === null) {
      return Promise.resolve(null);
    }

    // Muse seeds `title` with a placeholder until the first prompt lands;
    // the generated handle is a better name than that placeholder.
    const title = row.title === PLACEHOLDER_TITLE ? '' : row.title;
    const name = title === '' ? row.sessionName : title;
    const update = name === '' ? null : { name };

    return Promise.resolve(update);
  }

  canResume(session: ResumeCheck): boolean {
    return session.agentSessionID !== undefined;
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    const resume = agentSessionID === undefined ? 'muse resume' : `muse resume ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && ${resume}`;
  }
}

interface SessionIndexRow {
  readonly title: string;
  readonly sessionName: string;
}

/**
 * Reads one session's names out of Muse's session index. Opened read-only so
 * a running Muse never contends with atc for the write lock, and total: a
 * missing, locked, or reshaped index reads as no name rather than throwing
 * into the daemon.
 */
function readSessionIndexRow(sessionID: string): SessionIndexRow | null {
  const index = join(resolveMuseDataHome(), 'session-index.db');

  if (!existsSync(index)) {
    return null;
  }

  let db: Database | undefined;

  try {
    db = new Database(index, { readonly: true });

    const row: unknown = db
      .query('SELECT title, session_name FROM sessions WHERE session_id = ?')
      .get(sessionID);

    if (row === null || typeof row !== 'object') {
      return null;
    }

    const title = 'title' in row && typeof row.title === 'string' ? row.title : '';

    const sessionName =
      'session_name' in row && typeof row.session_name === 'string' ? row.session_name : '';

    return { title, sessionName };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
