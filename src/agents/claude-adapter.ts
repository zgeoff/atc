import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { HookEvent } from '../daemon/hooks';
import type { AgentSessionID } from '../shared/agent-session-id';
import { buildOptionalString } from '../shared/build-optional-string';
import type { Config } from '../shared/config';
import { isRecord } from '../shared/report';
import { toShellArg } from '../shared/to-shell-arg';
import type {
  AdapterEvent,
  AgentAdapter,
  HeadlessRunner,
  NameUpdate,
  ResumeCheck,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import { truncateDetail } from './truncate-detail';
import { writeHookSettings } from './write-hook-settings';

// Claude's hook payload keys, snake_case. An absent or wrong-typed field
// parses to undefined rather than failing the payload, so a broken reporter
// never breaks the session it reports on.
const CLAUDE_HOOK_PAYLOAD_SCHEMA = z.object({
  session_id: buildOptionalString(),
  transcript_path: buildOptionalString(),
  message: buildOptionalString(),
  last_assistant_message: buildOptionalString(),
  prompt: buildOptionalString(),
});

type ClaudeHookPayload = z.infer<typeof CLAUDE_HOOK_PAYLOAD_SCHEMA>;

/**
 * The Claude Code adapter: spawn arguments, `--settings` instrumentation,
 * resume semantics, transcript name-pulling, and statusline chaining.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';

  readonly headlessRunner: HeadlessRunner | null;

  // Claude's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  private readonly config: Config;

  // Written on first spawn so constructing the adapter touches no state.
  private settingsFile: string | undefined;

  constructor(config: Config, headlessRunner: HeadlessRunner | null = null) {
    this.config = config;
    this.headlessRunner = headlessRunner;
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    this.settingsFile ??= writeHookSettings({ id: this.id });

    return {
      bin: this.config.claudeBin,
      args: [
        ...this.config.claudeArgs,
        '--settings',
        this.settingsFile,
        ...(opts.resume === true ? ['--resume'] : []),
        ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  normalizeHook(e: HookEvent): AdapterEvent {
    const parsed = CLAUDE_HOOK_PAYLOAD_SCHEMA.safeParse(e.payload);
    const payload: ClaudeHookPayload = parsed.success ? parsed.data : {};

    const base: AdapterEvent = {
      kind: 'heartbeat',
      ...(payload.session_id === undefined
        ? {}
        : // oxlint-disable-next-line no-unsafe-type-assertion -- the hook payload's session_id is an agent session id by contract; this is the one point where it is trusted
          { agentSessionID: payload.session_id as AgentSessionID }),
    };

    const named: AdapterEvent = {
      ...base,
      ...(payload.transcript_path === undefined
        ? {}
        : { nameSource: payload.transcript_path, transcriptSource: payload.transcript_path }),
    };

    switch (e.event) {
      case 'SessionStart': {
        return { ...named, kind: 'started' };
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
      case 'UserPromptSubmit': {
        const preview = payload.prompt === undefined ? '' : payload.prompt.slice(0, 80);

        return {
          ...named,
          kind: 'prompt-submitted',
          ...(preview === '' ? {} : { message: preview, detail: truncateDetail(preview) }),
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

  // Claude is the naming authority: /rename writes custom-title lines to the
  // transcript, auto-summaries write summary lines. A custom title always
  // wins; a summary never overrides a user-typed name.
  async loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    try {
      const proc = Bun.spawn(['grep', '-E', '"type":"(custom-title|summary)"', source], {
        stdout: 'pipe',
        stderr: 'ignore',
      });

      const text = await new Response(proc.stdout).text();

      let title: string | undefined;
      let summary: string | undefined;

      for (const line of text.split('\n')) {
        if (line.trim() === '') {
          continue;
        }

        try {
          const parsed: unknown = JSON.parse(line);

          if (!isRecord(parsed)) {
            continue;
          }

          const customTitle = parsed['customTitle'];
          const summaryText = parsed['summary'];

          if (parsed['type'] === 'custom-title' && typeof customTitle === 'string') {
            title = customTitle;
          }

          if (parsed['type'] === 'summary' && typeof summaryText === 'string') {
            summary = summaryText;
          }
        } catch {}
      }

      if (title !== undefined && title !== '') {
        return { name: title, namedBy: 'agent' };
      }

      if (namedBy !== 'user' && summary !== undefined && summary !== '') {
        return { name: summary };
      }

      return null;
    } catch {
      return null;
    }
  }

  canResume(session: ResumeCheck): boolean {
    if (session.transcriptSource === undefined) {
      return true;
    }

    return existsSync(session.transcriptSource);
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    const resume =
      agentSessionID === undefined ? 'claude --resume' : `claude --resume ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && ${resume}`;
  }
}
