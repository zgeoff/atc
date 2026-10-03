import type { AdapterEvent } from '../protocol/adapter-event';
import type { HookEvent } from '../protocol/hook-event';
import type { AgentID } from '../shared/agent-id';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { GatewayConfig } from '../shared/collect-gateways';
import type { Config } from '../shared/config';
import { toShellArg } from '../shared/to-shell-arg';
import type {
  AgentAdapter,
  AgentProfile,
  HeadlessRunner,
  NameUpdate,
  ResumeCheck,
  SpawnOptionSpecs,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import { buildClaudeOverrideArgs } from './build-claude-override-args';
import { buildRestoreModeArgs } from './build-restore-mode-args';
import { ClaudeAdapter } from './claude-adapter';
import { CLAUDE_EFFORT_LEVELS } from './claude-effort-levels';
import { findFlagValue } from './find-flag-value';
import { makeClaudeHeadlessRunner } from './make-claude-headless-runner';
import type { ClaudeHeadlessRun } from './make-claude-headless-runner';
import { parseClaudeTranscriptLine } from './parse-claude-transcript-line';
import { planTypedLineInput } from './plan-typed-line-input';
import { resolveClaudePermissionMode } from './resolve-claude-permission-mode';
import { writeATCBridge } from './write-atc-bridge';
import { writeHookSettings } from './write-hook-settings';

/**
 * The Claude CLI pointed at a Claude-compatible backend other than the
 * default one. Hooks, transcripts, and resume semantics are the CLI's, so
 * they come straight from the Claude adapter; only the spawn plan and the
 * resume command differ, because both have to name the settings file that
 * carries the backend.
 */
export class GatewayAdapter implements AgentAdapter {
  readonly id: AgentID;

  // A headless turn carries the same settings file the terminal spawn does,
  // so it reaches this backend rather than the default one.
  readonly headlessRunner: HeadlessRunner | null;

  // The CLI's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  // The gateway runs the Claude CLI, which writes the same transcript.
  readonly parseTranscriptLine = parseClaudeTranscriptLine;

  // The gateway runs the Claude CLI, whose TUI takes a line the same way.
  readonly planLineInput = planTypedLineInput;

  readonly takesMessages = true;

  readonly profile: AgentProfile;

  private readonly gateway: GatewayConfig;

  private readonly claude: ClaudeAdapter;

  // Written on first spawn so constructing the adapter touches no state.
  private settingsFile: string | undefined;

  // Written on first spawn so constructing the adapter touches no state.
  private bridgeDir: string | undefined;

  private readonly bridgeTarget: string | undefined;

  constructor(
    gateway: GatewayConfig,
    config: Config,
    headlessRun: ClaudeHeadlessRun | null = null,
    bridgeTarget?: string,
  ) {
    this.bridgeTarget = bridgeTarget;
    this.gateway = gateway;
    this.id = gateway.id;

    const models = pickModels(gateway.env);

    this.profile = {
      label: gateway.label,
      kind: 'gateway',
      bin: gateway.bin,
      models,
      spawnOptions: buildGatewaySpawnOptions(gateway.args, models),
    };

    this.claude = new ClaudeAdapter(config);

    this.headlessRunner =
      headlessRun === null
        ? null
        : makeClaudeHeadlessRunner(headlessRun, {
            claudeBin: gateway.bin,
            permissionMode: resolveClaudePermissionMode(gateway.args, gateway.settings),
            pluginDir: () => this.writeBridge(),
            settings: () => this.writeSettings(),
          });
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    return {
      bin: this.gateway.bin,
      args: [
        ...buildClaudeOverrideArgs(this.gateway.args, opts),
        ...(opts.resume === false
          ? []
          : buildRestoreModeArgs(this.gateway.args, this.gateway.settings)),
        '--settings',
        this.writeSettings(),
        '--plugin-dir',
        this.writeBridge(),
        ...(opts.resume === true ? ['--resume'] : []),
        ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  // The credential helper runs on the daemon's machine, so a gateway
  // session never runs on a remote host.
  planGuestSpawn(): null {
    return null;
  }

  normalizeHook(e: HookEvent): AdapterEvent {
    return this.claude.normalizeHook(e);
  }

  loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    return this.claude.loadName(source, namedBy);
  }

  canResume(session: ResumeCheck): boolean {
    return this.claude.canResume(session);
  }

  // Shell command that re-opens this session outside atc. It carries the
  // gateway's configured arguments and its configured permission mode as an
  // explicit flag, so that mode overrides the one the CLI would restore, and
  // the generated settings file, because
  // without it the CLI would resume the session against the default backend.
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    const args = [
      ...this.gateway.args,
      ...buildRestoreModeArgs(this.gateway.args, this.gateway.settings),
    ]
      .map((arg) => ` ${toShellArg(arg)}`)
      .join('');

    const settings = toShellArg(this.writeSettings());
    const resume = agentSessionID === undefined ? '' : ` ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && ${this.gateway.bin}${args} --settings ${settings} --resume${resume}`;
  }

  private writeSettings(): string {
    this.settingsFile ??= writeHookSettings({
      id: this.id,
      env: { ANTHROPIC_BASE_URL: this.gateway.baseURL, ...this.gateway.env },
      ...(this.gateway.apiKeyHelper === undefined
        ? {}
        : { apiKeyHelper: this.gateway.apiKeyHelper }),
      ...(this.gateway.settings === undefined ? {} : { settings: this.gateway.settings }),
    });

    return this.settingsFile;
  }

  private writeBridge(): string {
    this.bridgeDir ??= writeATCBridge(this.bridgeTarget);

    return this.bridgeDir;
  }
}

// The model names a gateway's env sets explicitly, keyed by role:
// `ANTHROPIC_MODEL` is `default`, and `ANTHROPIC_DEFAULT_<TIER>_MODEL` is the
// tier in lower case. No other env value leaves the adapter.
const MODEL_KEY = /^ANTHROPIC_(?:DEFAULT_(?<tier>[A-Z0-9]+)_)?MODEL$/u;

function pickModels(
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | null {
  const models: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    const matched = MODEL_KEY.exec(key);

    if (matched !== null && value !== '') {
      models[matched.groups?.['tier']?.toLowerCase() ?? 'default'] = value;
    }
  }

  return Object.keys(models).length === 0 ? null : models;
}

// The Claude tiers a gateway's env can map to a provider model.
const GATEWAY_TIERS = ['opus', 'sonnet', 'haiku'];

// What a gateway spawn can override. The model examples are the tier aliases
// the gateway's env maps, each with the provider model it reaches. Effort
// goes to the CLI unchanged, and whether the provider acts on it is unknown.
function buildGatewaySpawnOptions(
  args: readonly string[],
  models: Readonly<Record<string, string>> | null,
): SpawnOptionSpecs {
  const examples = GATEWAY_TIERS.flatMap((tier) => {
    const mapped = models?.[tier];

    return mapped === undefined ? [] : [{ value: tier, resolvesTo: mapped }];
  });

  return {
    model: {
      supported: true,
      values: null,
      examples,
      default: findFlagValue(args, ['--model']) ?? models?.['default'] ?? null,
      backendEffect: 'applied',
      note: "A tier alias the gateway's env maps, or a model name the provider accepts, passed as --model.",
    },
    effort: {
      supported: true,
      values: CLAUDE_EFFORT_LEVELS,
      examples: [],
      default: findFlagValue(args, ['--effort']),
      backendEffect: 'unverified',
      note: "Passed as --effort; the gateway's provider may ignore it.",
    },
  };
}
