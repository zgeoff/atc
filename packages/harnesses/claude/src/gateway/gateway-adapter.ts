import type { Config } from '@atc/config/config';
import { resolveAuthProfiles } from '@atc/config/resolve-auth-profiles';
import type { AgentID } from '@atc/core/agent-id';
import type { AgentSessionID } from '@atc/core/agent-session-id';
import { BROKER_PLACEHOLDER } from '@atc/core/broker-placeholder';
import { CLAUDE_CREDENTIAL_VARIABLES } from '@atc/core/claude-credential-variables';
import { isBrokerVariable } from '@atc/core/is-broker-variable';
import { isRecord } from '@atc/core/is-record';
import type { SessionID } from '@atc/core/session-id';
import { toShellArg } from '@atc/core/to-shell-arg';
import type {
  AgentAdapter,
  AgentProfile,
  AuthSelection,
  GuestPaths,
  GuestSpawnPlan,
  HeadlessRunner,
  HookPlan,
  NameUpdate,
  ProjectSettingsCheck,
  ResumeCheck,
  SpawnOptionSpecs,
  SpawnOptions,
  SpawnPlan,
} from '@atc/plugin-api/agent-adapter';
import { buildAuthRevisionFolder } from '@atc/plugin-api/harness/build-auth-revision-folder';
import { canResumeFromTranscript } from '@atc/plugin-api/harness/can-resume-from-transcript';
import { findFlagValue } from '@atc/plugin-api/harness/find-flag-value';
import type { HostServices } from '@atc/plugin-api/host-services';
import { DaemonError } from '@atc/protocol/daemon-error';
import type { HookEvent } from '@atc/protocol/hook-event';
import { buildGuestBridgeFiles } from '../bridge/build-guest-bridge-files';
import { buildClaudeArgs } from '../build-claude-args';
import { buildClaudeHookEvent } from '../build-claude-hook-event';
import { buildHookSettings } from '../build-hook-settings';
import { buildRestoreModeArgs } from '../build-restore-mode-args';
import type { ClaudeAdapterOptions } from '../claude-adapter-options';
import { CLAUDE_EFFORT_LEVELS } from '../claude-effort-levels';
import { ClaudeLaunchFiles } from '../claude-launch-files';
import type { GatewayConfig } from '../config/collect-gateways';
import { createLocalScratchDir } from '../create-local-scratch-dir';
import { findClaudeMenu } from '../find-claude-menu';
import { findClaudePermissionMode } from '../find-claude-permission-mode';
import { buildClaudeConfigSeed } from '../guest/build-claude-config-seed';
import { buildClaudeGuestLaunch } from '../guest/build-claude-guest-launch';
import { buildClaudeProjectSettingsCheck } from '../guest/build-claude-project-settings-check';
import { makeClaudeHeadlessRunner } from '../headless/make-claude-headless-runner';
import { loadClaudeName } from '../load-claude-name';
import { parseClaudeTranscriptLine } from '../parse-claude-transcript-line';
import { planClaudeLineInput } from '../plan-claude-line-input';
import { resolveClaudePermissionMode } from '../resolve-claude-permission-mode';
import { SESSION_SCRATCH_FOLDER } from '../session-scratch-folder';

/**
 * The Claude CLI pointed at a Claude-compatible backend other than the
 * default one. Hooks, transcripts, naming, and resume semantics are the
 * CLI's, so the gateway reads them as stock Claude does; only the spawn
 * plan and the resume command differ, because both have to name the
 * settings file that carries the backend.
 */
export class GatewayAdapter implements AgentAdapter {
  readonly id: AgentID;

  // A headless turn carries the same settings file the terminal spawn does,
  // so it reaches this backend rather than the default one. A gateway whose
  // credential comes through impd's broker alone runs no headless turn.
  readonly headlessRunner: HeadlessRunner | null;

  // The CLI's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  // The gateway runs the Claude CLI, which writes the same transcript.
  readonly parseTranscriptLine = parseClaudeTranscriptLine;

  // The gateway runs the Claude CLI, whose TUI takes a line the same way.
  readonly planLineInput = planClaudeLineInput;

  // The gateway runs the Claude CLI, whose dialogs draw the same menus.
  readonly findMenu = findClaudeMenu;

  readonly takesMessages = true;

  readonly loadName: (
    source: string,
    namedBy: 'user' | 'auto' | 'agent',
  ) => Promise<NameUpdate | null> = loadClaudeName;

  readonly canResume: (session: ResumeCheck) => boolean = canResumeFromTranscript;

  readonly profile: AgentProfile;

  private readonly gateway: GatewayConfig;

  private readonly config: Pick<Config, 'authProfiles'>;

  private readonly options: ClaudeAdapterOptions;

  // The settings file carries the backend's base URL, its environment, its
  // credential helper, and its settings.
  private readonly files: ClaudeLaunchFiles;

  constructor(
    gateway: GatewayConfig,
    config: Pick<Config, 'authProfiles'>,
    host: Pick<HostServices, 'atcArgv'>,
    options: ClaudeAdapterOptions = {},
  ) {
    const headlessRun = options.headlessRun ?? null;

    this.options = options;
    this.gateway = gateway;
    this.config = config;
    this.id = gateway.id;

    this.files = new ClaudeLaunchFiles(
      {
        id: gateway.id,
        env: { ANTHROPIC_BASE_URL: gateway.baseURL, ...gateway.env },
        ...(gateway.apiKeyHelper === undefined ? {} : { apiKeyHelper: gateway.apiKeyHelper }),
        ...(gateway.settings === undefined ? {} : { settings: gateway.settings }),
      },
      host.atcArgv,
      options,
    );

    const models = pickModels(gateway.env);

    this.profile = {
      label: gateway.label,
      kind: 'gateway',
      bin: gateway.bin,
      models,
      spawnOptions: buildGatewaySpawnOptions(gateway.args, models),
    };

    this.headlessRunner =
      headlessRun === null || isBrokerOnlyGateway(gateway)
        ? null
        : makeClaudeHeadlessRunner(headlessRun, {
            claudeBin: gateway.bin,
            permissionMode: resolveClaudePermissionMode(gateway.args, gateway.settings),
            pluginDir: () => this.files.writeBridge(),
            settings: () => this.files.writeSettings(),
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
      brokerRequired: isBrokerOnlyGateway(this.gateway),
    };
  }

  // A gateway whose credential comes through impd's broker alone never
  // starts on the daemon's machine: started without the broker, the CLI
  // would send whatever credential it holds to the gateway's host. One
  // with a credential helper as well starts there under that helper. A
  // session's scratch folder lies under its own folder in atc's state
  // folder, and is its temporary folder too.
  planSpawn(opts: SpawnOptions, session?: SessionID): SpawnPlan {
    if (isBrokerOnlyGateway(this.gateway)) {
      throw this.buildBrokerRefusal('which only an imp target can give it');
    }

    const modeArgs =
      opts.resume === false ? [] : buildRestoreModeArgs(this.gateway.args, this.gateway.settings);

    const scratch =
      session === undefined ? null : createLocalScratchDir(session, this.options.stateDir);

    return {
      bin: this.gateway.bin,
      args: buildClaudeArgs(this.gateway.args, opts, {
        leadArgs: modeArgs,
        scratch,
        settings: this.files.writeSettings(),
        pluginDir: this.files.writeBridge(),
      }),
      ...(scratch === null ? {} : { env: { TMPDIR: scratch } }),
    };
  }

  // A gateway whose credential comes through impd's broker runs on a
  // remote host with a settings file of the session's own per binding
  // revision, a Claude config folder of its own that holds no account,
  // and placeholders in place of the credential, which the broker swaps
  // for the real one on the host's side. A shell seeds the config folder
  // before it runs the CLI, since a transferred file would replace the
  // state an earlier run left, and creates the session's scratch folder,
  // its temporary folder too. The launch takes the auth's own arguments
  // when it sets them, and never the credential helper, which runs on the
  // daemon's machine alone. A gateway without auth never runs remotely.
  // When the placeholder is the API key variable, the seed approves it and
  // the shell refuses to start under a host that sets the bearer variable.
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
    const settingsPath = `${buildAuthRevisionFolder(guest.auth.revision)}/settings.json`;

    const settings = buildHookSettings(
      {
        id: this.id,
        env: {
          ...this.gateway.env,
          ANTHROPIC_BASE_URL: this.gateway.baseURL,
          ...guest.auth.profileEnv,
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

    const args = this.gateway.auth.args ?? this.gateway.args;
    const approvedAPIKey = findAPIKeyPlaceholder(guest.auth.env);
    const refusedEnv = approvedAPIKey === null ? [] : [BEARER_PAIRING.variable];

    const launch = buildClaudeGuestLaunch(
      guest.dir,
      [
        this.gateway.bin,
        ...buildClaudeArgs(args, opts, {
          leadArgs: this.buildGuestModeArgs(args),
          scratch: `${guest.dir}/${SESSION_SCRATCH_FOLDER}`,
          settings: `${guest.dir}/${settingsPath}`,
          pluginDir: `${guest.dir}/atc-bridge`,
        }),
      ],
      refusedEnv,
    );

    return {
      bin: launch.bin,
      args: launch.args,
      files: {
        [settingsPath]: JSON.stringify(settings, null, 2),
        ...buildClaudeConfigSeed(null, approvedAPIKey),
        ...buildGuestBridgeFiles(argv),
      },
      env: { ...launch.env, ...guest.auth.profileEnv, ...guest.auth.env },
    };
  }

  planGuestWorkspaceTrust(root: string): Readonly<Record<string, string>> | null {
    if (this.gateway.auth === undefined) {
      return null;
    }

    const approvedAPIKey = findAPIKeyPlaceholder(this.gateway.auth.placeholderEnv);

    return buildClaudeConfigSeed(root, approvedAPIKey);
  }

  // The gateway runs the Claude CLI, whose hook lines it reads as stock
  // Claude does, with no state across a session's lines.
  planHookEvents(e: HookEvent): HookPlan {
    return { events: [buildClaudeHookEvent(e)] };
  }

  // Shell command that re-opens this session outside atc. It carries the
  // gateway's configured arguments and its configured permission mode as an
  // explicit flag, so that mode overrides the one the CLI would restore, and
  // the generated settings file, because without it the CLI would resume
  // the session against the default backend.
  // A gateway whose credential comes through impd's broker alone has none,
  // since outside atc the broker never reaches it.
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    if (isBrokerOnlyGateway(this.gateway)) {
      return null;
    }

    const args = [
      ...this.gateway.args,
      ...buildRestoreModeArgs(this.gateway.args, this.gateway.settings),
    ]
      .map((arg) => ` ${toShellArg(arg)}`)
      .join('');

    const settings = toShellArg(this.files.writeSettings());
    const resume = agentSessionID === undefined ? '' : ` ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && ${this.gateway.bin}${args} --settings ${settings} --resume${resume}`;
  }

  // A brokered session's Claude config is fresh, so the CLI's own default
  // mode would apply rather than the one the owner's settings set. Every
  // start therefore names its mode: the one the launch's arguments or the
  // gateway's settings set, else the CLI's manual mode, which asks before
  // each action.
  private buildGuestModeArgs(args: readonly string[]): string[] {
    if (findFlagValue(args, ['--permission-mode']) !== null) {
      return [];
    }

    return [
      '--permission-mode',
      findClaudePermissionMode([], this.gateway.settings) ?? MANUAL_PERMISSION_MODE,
    ];
  }

  // The repository's own settings files reach the CLI as well, so a launch
  // behind impd's broker reads them first.
  planProjectSettingsCheck(): ProjectSettingsCheck {
    return buildClaudeProjectSettingsCheck(this.id);
  }

  private buildBrokerRefusal(reason: string): DaemonError {
    return new DaemonError(
      'auth_target_unsupported',
      `gateway '${this.id}' takes its credential from impd's broker, ${reason}`,
      { agent: this.id },
    );
  }

  // The Claude CLI sends one of two variables as its credential, each in
  // its own header: ANTHROPIC_AUTH_TOKEN as a bearer authorization header,
  // and ANTHROPIC_API_KEY as a raw x-api-key header. The placeholders must
  // include exactly one of them, holding the placeholder, for a profile
  // whose rule on the base URL's host sets that variable's header. Any
  // other variable passes through to the session for a tool in it, whose
  // own host a selected profile covers, except the other credential
  // variables the CLI reads, which would put a second credential header on
  // the request that the broker never fills, and the variable that names
  // the session's Claude config folder, which atc sets itself.
  private findPlaceholderRefusal(
    env: Readonly<Record<string, string>>,
    profiles: readonly string[],
  ): DaemonError | null {
    const keys = Object.keys(env);
    const pairings = CREDENTIAL_PAIRINGS.filter((p) => keys.includes(p.variable));
    const [pairing] = pairings;

    if (pairing === undefined) {
      return this.buildPlaceholderRefusal(
        `needs ${BEARER_PAIRING.variable} or ${API_KEY_PAIRING.variable} among its placeholder variables, which the broker fills as a bearer authorization header or a raw x-api-key header; it has ${keys.length === 0 ? 'none' : keys.join(', ')}`,
      );
    }

    if (pairings.length > 1) {
      return this.buildPlaceholderRefusal(
        `cannot set both ${BEARER_PAIRING.variable} and ${API_KEY_PAIRING.variable} as placeholder variables, since the Claude CLI would send both headers and the broker fills one`,
      );
    }

    const competing = keys.find((key) => COMPETING_CREDENTIAL_VARIABLES.has(key));

    if (competing !== undefined) {
      return this.buildPlaceholderRefusal(
        `cannot use ${competing} as a placeholder variable, since the Claude CLI reads it as its own credential or config folder beside ${pairing.variable}`,
      );
    }

    if (env[pairing.variable] !== BROKER_PLACEHOLDER) {
      return this.buildPlaceholderRefusal(
        `needs ${pairing.variable} to hold ${BROKER_PLACEHOLDER}`,
      );
    }

    const resolution = resolveAuthProfiles(this.config.authProfiles, profiles);

    const host = new URL(this.gateway.baseURL).hostname;

    const rule =
      'resolved' in resolution
        ? resolution.resolved.secrets.flatMap((s) => s.rules).find((r) => r.host === host)
        : undefined;

    if (rule?.header !== pairing.header || rule.scheme !== pairing.scheme) {
      return this.buildPlaceholderRefusal(
        `needs a profile that sets ${pairing.description} for ${host}, the header ${pairing.variable} fills`,
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
}

// Whether a gateway takes its credential from impd's broker with no
// credential helper to fall back on, so it starts only behind the broker.
function isBrokerOnlyGateway(gateway: GatewayConfig): boolean {
  return gateway.auth !== undefined && gateway.apiKeyHelper === undefined;
}

/**
 * A variable the Claude CLI sends as its credential, and the header and
 * scheme impd's broker must set for the base URL's host to fill it.
 */
interface CredentialPairing {
  readonly variable: string;
  readonly header: string;
  readonly scheme: 'bearer' | 'raw';
  readonly description: string;
}

const BEARER_PAIRING: CredentialPairing = {
  variable: CLAUDE_CREDENTIAL_VARIABLES.authToken,
  header: 'authorization',
  scheme: 'bearer',
  description: 'a bearer authorization header',
};

const API_KEY_PAIRING: CredentialPairing = {
  variable: CLAUDE_CREDENTIAL_VARIABLES.apiKey,
  header: 'x-api-key',
  scheme: 'raw',
  description: 'a raw x-api-key header',
};

const CREDENTIAL_PAIRINGS: readonly CredentialPairing[] = [BEARER_PAIRING, API_KEY_PAIRING];

// The placeholder a session sends as an x-api-key header, or null when it
// sends a bearer header. The CLI asks a person whether to use that
// variable unless its config approves it, and a bearer variable set by the
// host would put a second credential header beside it, which the backend
// refuses.
function findAPIKeyPlaceholder(env: Readonly<Record<string, string>>): string | null {
  return env[API_KEY_PAIRING.variable] ?? null;
}

// Variables the Claude CLI reads as its own credential beside either
// pairing's variable, plus the one that points it at the session's config
// folder, whose launch value a placeholder would overwrite.
const COMPETING_CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  CLAUDE_CREDENTIAL_VARIABLES.oauthToken,
  'CLAUDE_CONFIG_DIR',
]);

// The Claude CLI's mode that asks a person before each action.
const MANUAL_PERMISSION_MODE = 'default';

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
