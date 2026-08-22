import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
import { buildOptionalString } from './build-optional-string';
import type { Config } from './config';
import type { HookEvent } from './hooks';
import { normalizeHookEventName } from './normalize-hook-event';
import { isRecord } from './report';
import { resolveAgentHome } from './resolve-agent-home';
import type { SessionID } from './session-id';
import { toShellArg } from './to-shell-arg';
import { truncateDetail } from './truncate-detail';

interface GrokSessionHookState {
  latestPromptID?: string;
  lastKind: AdapterEvent['kind'];
}

// Bounds per-session hook state so a Grok session killed or crashed without
// a SessionEnd hook cannot grow it for the daemon's whole lifetime.
const MAX_HOOK_STATE_ENTRIES = 256;

// Grok's hook payload keys, camelCase. An absent or wrong-typed field parses
// to undefined rather than failing the payload, so a broken reporter never
// breaks the session it reports on.
const GROK_HOOK_PAYLOAD_SCHEMA = z.object({
  sessionId: buildOptionalString(),
  cwd: buildOptionalString(),
  promptId: buildOptionalString(),
  subagentType: buildOptionalString(),
  prompt: buildOptionalString(),
  notificationType: buildOptionalString(),
  message: buildOptionalString(),
  reason: buildOptionalString(),
  lastAssistantMessage: buildOptionalString(),
});

type GrokHookPayload = z.infer<typeof GROK_HOOK_PAYLOAD_SCHEMA>;

/**
 * The Grok Build adapter: spawn arguments, hook payload mapping,
 * resume semantics, and summary.json name-pulling.
 */
export class GrokAdapter implements AgentAdapter {
  readonly id = 'grok';

  // Grok has no headless handoff.
  readonly headlessRunner = null;

  // Grok's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  private readonly config: Config;

  private readonly hookState = new Map<SessionID, GrokSessionHookState>();

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
    const parsed = GROK_HOOK_PAYLOAD_SCHEMA.safeParse(e.payload);
    const payload: GrokHookPayload = parsed.success ? parsed.data : {};

    const agentSessionID =
      payload.sessionId === undefined
        ? undefined
        : // oxlint-disable-next-line no-unsafe-type-assertion -- the hook payload's sessionId is an agent session id by contract; this is the one point where it is trusted
          (payload.sessionId as AgentSessionID);

    const base: AdapterEvent = {
      kind: 'heartbeat',
      ...(agentSessionID === undefined ? {} : { agentSessionID }),
    };

    const named: AdapterEvent = {
      ...base,
      ...(agentSessionID !== undefined && payload.cwd !== undefined
        ? { nameSource: buildGrokNameSource(agentSessionID, payload.cwd) }
        : {}),
    };

    if (payload.subagentType !== undefined && payload.subagentType !== '') {
      return this.emitHook(e.atcId, { ...base, kind: 'heartbeat' });
    }

    const event = normalizeHookEventName(e.event);
    const prior = this.hookState.get(e.atcId);
    const promptID = payload.promptId;

    const stale =
      promptID !== undefined &&
      prior?.latestPromptID !== undefined &&
      promptID !== prior.latestPromptID;

    switch (event) {
      case 'SessionStart': {
        return this.emitHook(e.atcId, { ...named, kind: 'started' });
      }
      case 'UserPromptSubmit': {
        const preview = payload.prompt === undefined ? '' : payload.prompt.slice(0, 80);

        return this.emitHook(
          e.atcId,
          {
            ...named,
            kind: 'prompt-submitted',
            ...(preview === '' ? {} : { message: preview, detail: truncateDetail(preview) }),
          },
          promptID,
        );
      }
      case 'Notification': {
        const notificationType = payload.notificationType;
        const message = payload.message;

        if (notificationType === 'permission_prompt') {
          return this.emitHook(e.atcId, {
            ...base,
            kind: 'needs-input',
            ...(message !== undefined && message !== ''
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
        if (payload.reason !== 'end_turn' || stale) {
          return this.emitHook(e.atcId, base);
        }

        return this.emitHook(e.atcId, buildTurnDoneEvent(named, payload));
      }
      case 'StopFailure':
      case 'StopCancelled': {
        if (stale) {
          return this.emitHook(e.atcId, base);
        }

        return this.emitHook(e.atcId, buildTurnDoneEvent(named, payload));
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
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    const resume = agentSessionID === undefined ? 'grok' : `grok --resume ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && ${resume}`;
  }

  private emitHook(
    atcID: SessionID,
    event: Readonly<AdapterEvent>,
    promptID?: string,
  ): AdapterEvent {
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

function buildGrokNameSource(sessionID: AgentSessionID, cwd: string): string {
  return join(
    resolveAgentHome('GROK_HOME', '.grok'),
    'sessions',
    encodeURIComponent(cwd),
    sessionID,
    'summary.json',
  );
}

function buildTurnDoneEvent(named: Readonly<AdapterEvent>, payload: GrokHookPayload): AdapterEvent {
  const lastMessage = payload.lastAssistantMessage;

  return {
    ...named,
    kind: 'turn-done',
    ...(lastMessage !== undefined && lastMessage !== ''
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

  const root = join(resolveAgentHome('GROK_HOME', '.grok'), 'sessions');

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
