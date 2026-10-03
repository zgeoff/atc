import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { HookEvent } from '../daemon/hooks';
import type { AgentSessionID } from '../shared/agent-session-id';
import { buildOptionalString } from '../shared/build-optional-string';
import type { Config } from '../shared/config';
import { isRecord } from '../shared/report';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toShellArg } from '../shared/to-shell-arg';
import type {
  AdapterEvent,
  AgentAdapter,
  AgentProfile,
  GuestPaths,
  GuestSpawnPlan,
  HeadlessRunner,
  NameUpdate,
  ResumeCheck,
  SpawnOptionSpecs,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import { buildATCBridgeFiles } from './build-atc-bridge-files';
import { buildClaudeOverrideArgs } from './build-claude-override-args';
import { buildHookSettings } from './build-hook-settings';
import { CLAUDE_EFFORT_LEVELS } from './claude-effort-levels';
import { findClaudePermissionMode } from './find-claude-permission-mode';
import { findFlagValue } from './find-flag-value';
import { makeClaudeHeadlessRunner } from './make-claude-headless-runner';
import type { ClaudeHeadlessRun } from './make-claude-headless-runner';
import { parseClaudeTranscriptLine } from './parse-claude-transcript-line';
import { resolveClaudePermissionMode } from './resolve-claude-permission-mode';
import { truncateDetail } from './truncate-detail';
import { writeATCBridge } from './write-atc-bridge';
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

  readonly parseTranscriptLine = parseClaudeTranscriptLine;

  readonly profile: AgentProfile;

  readonly takesMessages = true;

  private readonly config: Config;

  // Written on first spawn so constructing the adapter touches no state.
  private settingsFile: string | undefined;

  // Written on first spawn so constructing the adapter touches no state.
  private bridgeDir: string | undefined;

  private readonly bridgeTarget: string | undefined;

  constructor(config: Config, headlessRun: ClaudeHeadlessRun | null = null, bridgeTarget?: string) {
    this.bridgeTarget = bridgeTarget;
    this.config = config;

    this.profile = {
      label: 'Claude',
      kind: 'claude',
      bin: config.claudeBin,
      models: null,
      spawnOptions: buildClaudeSpawnOptions(config.claudeArgs),
    };

    this.headlessRunner =
      headlessRun === null
        ? null
        : makeClaudeHeadlessRunner(headlessRun, {
            claudeBin: config.claudeBin,
            permissionMode: resolveClaudePermissionMode(config.claudeArgs, undefined),
            pluginDir: () => this.writeBridge(),
          });
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    this.settingsFile ??= writeHookSettings({ id: this.id });

    return {
      bin: this.config.claudeBin,
      args: this.buildArgs(opts, this.settingsFile, this.writeBridge()),
    };
  }

  // A remote session reports through the atc inside its host, so without
  // one it has no instrumentation and cannot run there. Its settings and
  // its copy of the mod travel with it, and it has no statusline.
  planGuestSpawn(opts: SpawnOptions, guest: GuestPaths): GuestSpawnPlan | null {
    if (guest.atc === null) {
      return null;
    }

    const argv = [guest.atc];

    const bridge = Object.entries(buildATCBridgeFiles(argv)).map(
      ([path, content]): [string, string] => [`atc-bridge/${path}`, content],
    );

    return {
      bin: this.config.claudeBin,
      args: this.buildArgs(opts, `${guest.dir}/settings.json`, `${guest.dir}/atc-bridge`),
      files: {
        'settings.json': JSON.stringify(buildHookSettings({ id: this.id }, 0, argv), null, 2),
        ...Object.fromEntries(bridge),
      },
    };
  }

  private buildArgs(opts: SpawnOptions, settings: string, pluginDir: string): string[] {
    return [
      ...buildClaudeOverrideArgs(this.config.claudeArgs, opts),
      '--settings',
      settings,
      '--plugin-dir',
      pluginDir,
      ...(opts.resume === true ? ['--resume'] : []),
      ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
      ...(opts.prompt === '' ? [] : [opts.prompt]),
    ];
  }

  private writeBridge(): string {
    this.bridgeDir ??= writeATCBridge(this.bridgeTarget);

    return this.bridgeDir;
  }

  normalizeHook(e: HookEvent): AdapterEvent {
    const parsed = CLAUDE_HOOK_PAYLOAD_SCHEMA.safeParse(e.payload);
    const payload: ClaudeHookPayload = parsed.success ? parsed.data : {};

    const base: AdapterEvent = {
      kind: 'heartbeat',
      ...(payload.session_id === undefined
        ? {}
        : { agentSessionID: toAgentSessionID(payload.session_id) }),
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
            ? { detail: truncateDetail(lastMessage), result: lastMessage }
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

  // Shell command that re-opens this session outside atc (or anywhere). A
  // permission mode the configured arguments set travels as an explicit
  // flag, so it overrides the mode the CLI would restore.
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    const configured = findClaudePermissionMode(this.config.claudeArgs, undefined);
    const mode = configured === null ? '' : ` --permission-mode ${toShellArg(configured)}`;
    const resume = agentSessionID === undefined ? '' : ` ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && claude${mode} --resume${resume}`;
  }
}

// The aliases Claude Code documents for `--model`, each resolving to a model
// the account picks. A full model name is accepted as well.
const CLAUDE_MODEL_ALIASES = [
  'best',
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'opus[1m]',
  'sonnet[1m]',
  'opusplan',
];

// What a Claude spawn can override. Each default is the value the configured
// arguments pass, or null when the CLI picks its own.
function buildClaudeSpawnOptions(claudeArgs: readonly string[]): SpawnOptionSpecs {
  return {
    model: {
      supported: true,
      values: null,
      examples: CLAUDE_MODEL_ALIASES.map((value) => ({ value, resolvesTo: null })),
      default: findFlagValue(claudeArgs, ['--model']),
      backendEffect: 'applied',
      note: 'An alias or a full model name, passed as --model.',
    },
    effort: {
      supported: true,
      values: CLAUDE_EFFORT_LEVELS,
      examples: [],
      default: findFlagValue(claudeArgs, ['--effort']),
      backendEffect: 'applied',
      note: 'Passed as --effort. Which levels a session honours depends on its model.',
    },
  };
}
