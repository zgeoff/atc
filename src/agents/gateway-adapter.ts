import type { AdapterEvent } from '../protocol/adapter-event';
import { DaemonError } from '../protocol/daemon-error';
import type { HookEvent } from '../protocol/hook-event';
import type { AgentID } from '../shared/agent-id';
import type { AgentSessionID } from '../shared/agent-session-id';
import type { GatewayConfig } from '../shared/collect-gateways';
import type { Config } from '../shared/config';
import { isBrokerVariable } from '../shared/is-broker-variable';
import { isRecord } from '../shared/report';
import { resolveAuthProfiles } from '../shared/resolve-auth-profiles';
import { toShellArg } from '../shared/to-shell-arg';
import type {
  AgentAdapter,
  AgentProfile,
  AuthSelection,
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
import { buildRestoreModeArgs } from './build-restore-mode-args';
import { ClaudeAdapter } from './claude-adapter';
import { CLAUDE_EFFORT_LEVELS } from './claude-effort-levels';
import { findClaudePermissionMode } from './find-claude-permission-mode';
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
  // so it reaches this backend rather than the default one. A gateway whose
  // credential comes through impd's broker runs no headless turn.
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

  private readonly config: Config;

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
    this.config = config;
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
      headlessRun === null || gateway.auth !== undefined
        ? null
        : makeClaudeHeadlessRunner(headlessRun, {
            claudeBin: gateway.bin,
            permissionMode: resolveClaudePermissionMode(gateway.args, gateway.settings),
            pluginDir: () => this.writeBridge(),
            settings: () => this.writeSettings(),
          });
  }

  // A gateway whose credential comes through impd's broker is refused
  // before anything is prepared for it when its placeholders cannot pair
  // with the broker's header, or when its settings env would route the CLI
  // around the broker.
  findSpawnRefusal(): DaemonError | null {
    const auth = this.gateway.auth;

    if (auth === undefined) {
      return null;
    }

    return (
      this.findPlaceholderRefusal(auth.placeholderEnv, auth.profiles) ??
      this.findSettingsEnvConflict()
    );
  }

  findAuthSelection(): AuthSelection | null {
    const auth = this.gateway.auth;

    if (auth === undefined) {
      return null;
    }

    return {
      gateway: { id: this.gateway.id, baseURL: this.gateway.baseURL, auth },
      profiles: this.config.authProfiles,
    };
  }

  // A gateway whose credential comes through impd's broker never starts on
  // the daemon's machine: started without the broker, the CLI would send
  // whatever credential it holds to the gateway's host.
  planSpawn(opts: SpawnOptions): SpawnPlan {
    if (this.gateway.auth !== undefined) {
      throw this.buildBrokerRefusal('which only an imp target can give it');
    }

    const modeArgs =
      opts.resume === false ? [] : buildRestoreModeArgs(this.gateway.args, this.gateway.settings);

    return {
      bin: this.gateway.bin,
      args: this.buildArgs(opts, modeArgs, this.writeSettings(), this.writeBridge()),
    };
  }

  // A gateway whose credential comes through impd's broker runs on a
  // remote host with a settings file of the session's own per binding
  // revision, a Claude config folder of its own that holds no account,
  // and placeholders in place of the credential, which the broker swaps
  // for the real one on the host's side. A shell seeds the config folder
  // before it runs the CLI, since a transferred file would replace the
  // state an earlier run left. Any other gateway's credential
  // helper runs on the daemon's machine, so it never runs remotely.
  planGuestSpawn(opts: SpawnOptions, guest: GuestPaths): GuestSpawnPlan | null {
    if (this.gateway.auth === undefined) {
      return null;
    }

    if (guest.auth === undefined) {
      throw this.buildBrokerRefusal('and this session has no broker binding');
    }

    if (guest.atc === null) {
      return null;
    }

    const refusal =
      this.findPlaceholderRefusal(guest.auth.env, this.gateway.auth.profiles) ??
      this.findSettingsEnvConflict();

    if (refusal !== null) {
      throw refusal;
    }

    const argv = [guest.atc];
    const settingsPath = `auth-r${guest.auth.revision}/settings.json`;

    const bridge = Object.entries(buildATCBridgeFiles(argv)).map(
      ([path, content]): [string, string] => [`atc-bridge/${path}`, content],
    );

    const settings = buildHookSettings(
      {
        id: this.id,
        env: {
          ...this.gateway.env,
          ANTHROPIC_BASE_URL: this.gateway.baseURL,
          ...guest.auth.env,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        ...(this.gateway.settings === undefined
          ? {}
          : { settings: buildSettingsWithoutHelper(this.gateway.settings) }),
      },
      0,
      argv,
    );

    const configDir = `${guest.dir}/${CLAUDE_CONFIG_FOLDER}`;

    return {
      bin: 'sh',
      args: [
        '-c',
        SEED_CONFIG_SCRIPT,
        'sh',
        configDir,
        `${guest.dir}/${CONFIG_SEED_FILE}`,
        this.gateway.bin,
        ...this.buildArgs(
          opts,
          this.buildGuestModeArgs(),
          `${guest.dir}/${settingsPath}`,
          `${guest.dir}/atc-bridge`,
        ),
      ],
      files: {
        [settingsPath]: JSON.stringify(settings, null, 2),
        [CONFIG_SEED_FILE]: JSON.stringify(ONBOARDED_CONFIG, null, 2),
        ...Object.fromEntries(bridge),
      },
      env: { CLAUDE_CONFIG_DIR: configDir, ...guest.auth.env },
    };
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
  // A gateway whose credential comes through impd's broker has none, since
  // outside atc the broker never reaches it.
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    if (this.gateway.auth !== undefined) {
      return null;
    }

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

  private buildArgs(
    opts: SpawnOptions,
    modeArgs: readonly string[],
    settings: string,
    pluginDir: string,
  ): string[] {
    return [
      ...buildClaudeOverrideArgs(this.gateway.args, opts),
      ...modeArgs,
      '--settings',
      settings,
      '--plugin-dir',
      pluginDir,
      ...(opts.resume === true ? ['--resume'] : []),
      ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
      ...(opts.prompt === '' ? [] : [opts.prompt]),
    ];
  }

  // A brokered session's Claude config is fresh, so the CLI's own default
  // mode would apply rather than the one the owner's settings set. Every
  // start therefore names its mode: the one the gateway's arguments or
  // settings set, else the CLI's manual mode, which asks before each
  // action.
  private buildGuestModeArgs(): string[] {
    if (findFlagValue(this.gateway.args, ['--permission-mode']) !== null) {
      return [];
    }

    return [
      '--permission-mode',
      findClaudePermissionMode([], this.gateway.settings) ?? MANUAL_PERMISSION_MODE,
    ];
  }

  private buildBrokerRefusal(reason: string): DaemonError {
    return new DaemonError(
      'auth_target_unsupported',
      `gateway '${this.id}' takes its credential from impd's broker, ${reason}`,
      { agent: this.id },
    );
  }

  // The Claude CLI sends ANTHROPIC_AUTH_TOKEN as a bearer authorization
  // header, the one pairing atc binds, so the placeholders must be that
  // variable alone, holding the placeholder, for a profile whose rule on
  // the base URL's host sets that header. Any other variable would put the
  // placeholder in a header the broker never fills.
  private findPlaceholderRefusal(
    env: Readonly<Record<string, string>>,
    profiles: readonly string[],
  ): DaemonError | null {
    const keys = Object.keys(env);

    if (keys.length !== 1 || keys[0] !== BEARER_VARIABLE) {
      return this.buildPlaceholderRefusal(
        `needs ${BEARER_VARIABLE} as its only placeholder variable, which the broker fills as a bearer authorization header; it has ${keys.length === 0 ? 'none' : keys.join(', ')}`,
      );
    }

    if (env[BEARER_VARIABLE] !== PLACEHOLDER) {
      return this.buildPlaceholderRefusal(`needs ${BEARER_VARIABLE} to hold ${PLACEHOLDER}`);
    }

    const resolution = resolveAuthProfiles(this.config.authProfiles, profiles);

    const host = new URL(this.gateway.baseURL).hostname;

    const rule =
      'resolved' in resolution
        ? resolution.resolved.secrets.flatMap((s) => s.rules).find((r) => r.host === host)
        : undefined;

    if (rule?.header !== 'authorization' || rule.scheme !== 'bearer') {
      return this.buildPlaceholderRefusal(
        `needs a profile that sets a bearer authorization header for ${host}, the header ${BEARER_VARIABLE} fills`,
      );
    }

    return null;
  }

  // The settings file's env block reaches the CLI's own process, so a proxy
  // or CA variable there would route the CLI around the broker.
  private findSettingsEnvConflict(): DaemonError | null {
    const settingsEnv = this.gateway.settings?.['env'];

    const keys = [
      ...Object.keys(this.gateway.env),
      ...(isRecord(settingsEnv) ? Object.keys(settingsEnv) : []),
    ];

    const variable = keys.find((key) => isBrokerVariable(key));

    if (variable === undefined) {
      return null;
    }

    return new DaemonError(
      'auth_target_unsupported',
      `gateway '${this.id}' sets ${variable} in its settings env, which would route around impd's broker`,
      { agent: this.id, problem: 'guest_env_conflict', variable },
    );
  }

  private buildPlaceholderRefusal(problem: string): DaemonError {
    return new DaemonError('auth_placeholder_unsupported', `gateway '${this.id}' ${problem}`, {
      agent: this.id,
    });
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

// The variable the Claude CLI sends as a bearer authorization header, and
// the value impd's broker replaces with the credential on the host's side.
const BEARER_VARIABLE = 'ANTHROPIC_AUTH_TOKEN';
const PLACEHOLDER = 'imp-broker-placeholder';

// The Claude CLI's mode that asks a person before each action.
const MANUAL_PERMISSION_MODE = 'default';

// The Claude config folder a brokered session gets inside its guest
// folder, so no account or setting of the host's image reaches it.
const CLAUDE_CONFIG_FOLDER = 'claude-config';

// The state the Claude CLI reads from its config folder's `.claude.json`
// to start without its first-run onboarding. It holds no account: the
// placeholder credential is what keeps the CLI from asking for a login.
// It holds no folder trust either, so the CLI asks a person to trust the
// workspace on its first start.
const ONBOARDED_CONFIG = { hasCompletedOnboarding: true };

// Where that state travels, beside the config folder rather than in it.
const CONFIG_SEED_FILE = 'claude-config-seed.json';

// Copies the seed into the config folder only when the folder holds no
// `.claude.json` yet, then runs the CLI. A resumed session keeps the state
// the CLI wrote, a folder trust a person accepted included. The arguments
// are the config folder, the seed, and the CLI's own command line.
const SEED_CONFIG_SCRIPT =
  'mkdir -p "$1" && { [ -e "$1/.claude.json" ] || cp "$2" "$1/.claude.json"; } && shift 2 && exec "$@"';

// The gateway's settings without a credential helper, which a brokered
// session never runs.
function buildSettingsWithoutHelper(
  settings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'apiKeyHelper'));
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
