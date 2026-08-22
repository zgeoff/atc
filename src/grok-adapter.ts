import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
import { normalizeHookEventName } from './normalize-hook-event';
import { isRecord } from './report';

interface GrokSessionHookState {
  latestPromptID?: string;
  lastKind: AdapterEvent['kind'];
}

// Bounds per-session hook state so a Grok session killed or crashed without
// a SessionEnd hook cannot grow it for the daemon's whole lifetime.
const MAX_HOOK_STATE_ENTRIES = 256;

/**
 * The Grok Build adapter: spawn arguments, hook payload mapping,
 * resume semantics, and summary.json name-pulling.
 */
export class GrokAdapter implements AgentAdapter {
  readonly id = 'grok';

  readonly kind: AgentKind = 'grok';

  // Grok has no headless handoff.
  readonly headlessRunner = null;

  // Grok's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  private readonly config: Config;

  private readonly hookState = new Map<string, GrokSessionHookState>();

  constructor(config: Config) {
    this.config = config;
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    return {
      bin: this.config.grokBin,
      args: [
        ...this.config.grokArgs.filter((arg) => arg !== '--leader' && arg !== '--no-leader'),
        '--no-leader',
        ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  normalizeHook(e: HookEvent): AdapterEvent {
    const sessionID = e.payload['sessionId'];
    const cwd = e.payload['cwd'];
    const promptID = e.payload['promptId'];
    const subagentType = e.payload['subagentType'];

    const base: AdapterEvent = {
      kind: 'heartbeat',
      ...(typeof sessionID === 'string' ? { agentSessionID: sessionID } : {}),
    };

    const named: AdapterEvent = {
      ...base,
      ...(typeof sessionID === 'string' && typeof cwd === 'string'
        ? { nameSource: buildGrokNameSource(sessionID, cwd) }
        : {}),
    };

    if (typeof subagentType === 'string' && subagentType !== '') {
      return this.emitHook(e.atcId, { ...base, kind: 'heartbeat' });
    }

    const event = normalizeHookEventName(e.event);
    const prior = this.hookState.get(e.atcId);

    const stale =
      typeof promptID === 'string' &&
      prior?.latestPromptID !== undefined &&
      promptID !== prior.latestPromptID;

    switch (event) {
      case 'SessionStart': {
        return this.emitHook(e.atcId, { ...named, kind: 'started' });
      }
      case 'UserPromptSubmit': {
        const prompt = e.payload['prompt'];
        const preview = typeof prompt === 'string' ? prompt.slice(0, 80) : '';
        const submittedID = typeof promptID === 'string' ? promptID : undefined;

        return this.emitHook(
          e.atcId,
          {
            ...named,
            kind: 'prompt-submitted',
            ...(preview === '' ? {} : { message: preview, detail: truncateDetail(preview) }),
          },
          submittedID,
        );
      }
      case 'Notification': {
        const notificationType = e.payload['notificationType'];
        const message = e.payload['message'];

        if (notificationType === 'permission_prompt') {
          return this.emitHook(e.atcId, {
            ...base,
            kind: 'needs-input',
            ...(typeof message === 'string' && message !== ''
              ? { message, detail: truncateDetail(message) }
              : {}),
          });
        }

        if (notificationType === 'idle_prompt') {
          const kind = prior?.lastKind === 'needs-input' ? 'heartbeat' : 'turn-done';

          return this.emitHook(e.atcId, { ...named, kind });
        }

        return this.emitHook(e.atcId, base);
      }
      case 'Stop': {
        if (e.payload['reason'] !== 'end_turn' || stale) {
          return this.emitHook(e.atcId, base);
        }

        return this.emitHook(e.atcId, buildTurnDoneEvent(named, e.payload));
      }
      case 'StopFailure':
      case 'StopCancelled': {
        if (stale) {
          return this.emitHook(e.atcId, base);
        }

        return this.emitHook(e.atcId, buildTurnDoneEvent(named, e.payload));
      }
      case 'SessionEnd': {
        this.hookState.delete(e.atcId);

        return { ...base, kind: 'ended' };
      }
      default: {
        return this.emitHook(e.atcId, base);
      }
    }
  }

  loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    const parsed = readSummary(source) ?? readSummary(findGrokSummary(source));

    if (parsed === null) {
      return Promise.resolve(null);
    }

    const generated = parsed['generated_title'];
    const summary = parsed['session_summary'];
    const title = typeof generated === 'string' ? generated : '';
    const sessionSummary = typeof summary === 'string' ? summary : '';

    if (parsed['title_is_manual'] === true && title !== '') {
      return Promise.resolve({ name: title, namedBy: 'agent' });
    }

    if (namedBy !== 'user' && title !== '') {
      return Promise.resolve({ name: title });
    }

    if (namedBy !== 'user' && sessionSummary !== '') {
      return Promise.resolve({ name: sessionSummary });
    }

    return Promise.resolve(null);
  }

  canResume(session: ResumeCheck): boolean {
    return session.agentSessionID !== undefined;
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(cwd: string, agentSessionID: string | undefined): string | null {
    const resume = agentSessionID === undefined ? 'grok' : `grok --resume ${agentSessionID}`;
    const quoted = cwd.replaceAll("'", String.raw`'\''`);

    return `cd '${quoted}' && ${resume}`;
  }

  private emitHook(atcID: string, event: Readonly<AdapterEvent>, promptID?: string): AdapterEvent {
    const prior = this.hookState.get(atcID);
    const latestPromptID = promptID ?? prior?.latestPromptID;

    const tracked =
      event.kind === 'needs-input' ||
      event.kind === 'prompt-submitted' ||
      event.kind === 'turn-done'
        ? event.kind
        : (prior?.lastKind ?? event.kind);

    if (prior === undefined && this.hookState.size >= MAX_HOOK_STATE_ENTRIES) {
      this.removeOldestHookState();
    }

    this.hookState.set(atcID, {
      lastKind: tracked,
      ...(latestPromptID === undefined ? {} : { latestPromptID }),
    });

    return event;
  }

  // A Map preserves insertion order, so the first key is the oldest entry.
  private removeOldestHookState(): void {
    const oldest = this.hookState.keys().next().value;

    if (oldest !== undefined) {
      this.hookState.delete(oldest);
    }
  }
}

function resolveGrokHome(): string {
  const home = process.env['GROK_HOME'];

  return home !== undefined && home !== '' ? home : join(homedir(), '.grok');
}

function buildGrokNameSource(sessionID: string, cwd: string): string {
  return join(resolveGrokHome(), 'sessions', encodeURIComponent(cwd), sessionID, 'summary.json');
}

function buildTurnDoneEvent(
  named: Readonly<AdapterEvent>,
  payload: Readonly<Record<string, unknown>>,
): AdapterEvent {
  const lastMessage = payload['lastAssistantMessage'];

  return {
    ...named,
    kind: 'turn-done',
    ...(typeof lastMessage === 'string' && lastMessage !== ''
      ? { detail: truncateDetail(lastMessage) }
      : {}),
  };
}

function readSummary(source: string | null): Record<string, unknown> | null {
  if (source === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(source, 'utf8'));

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findGrokSummary(source: string): string | null {
  const sessionID = source.split('/').at(-2);

  if (sessionID === undefined || sessionID === '') {
    return null;
  }

  const root = join(resolveGrokHome(), 'sessions');

  try {
    for (const group of readdirSync(root)) {
      const candidate = join(root, group, sessionID, 'summary.json');

      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {}

  return null;
}

function truncateDetail(text: string): string {
  return text.length <= 600 ? text : `${text.slice(0, 599)}…`;
}
