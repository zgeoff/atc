import type { Config } from '@atc/config';
import { resolveAuthProfiles } from '@atc/config';
import {
  BROKER_PLACEHOLDER,
  CLAUDE_CREDENTIAL_VARIABLES,
  isBrokerVariable,
  isRecord,
  toShellArg,
} from '@atc/core';
import type {
  AgentAdapter,
  AgentProfile,
  AuthSelection,
  GuestPaths,
  GuestSpawnPlan,
  HookPlan,
  HostServices,
  LineInputStep,
  ProjectSettingsCheck,
  ScreenMenu,
  SpawnOptionSpecs,
  SpawnOptions,
  TerminalInputModes,
} from '@atc/plugin-api';
import { buildAuthRevisionFolder, findFlagValue, probeTranscriptResumable } from '@atc/plugin-api';
import type { HookEvent } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import type { AgentSessionID, SessionID, TranscriptRow } from '@atcx/contract';
import { buildGuestBridgeFiles } from '../bridge/build-guest-bridge-files';
import { buildClaudeArgs } from '../build-claude-args';
import { buildClaudeHookEvent } from '../build-claude-hook-event';
import { buildHookSettings } from '../build-hook-settings';
import { buildPluginDirsOption } from '../build-plugin-dirs-option';
import { buildRestoreModeArgs } from '../build-restore-mode-args';
import type { ClaudeAdapterOptions } from '../claude-adapter-options';
import { CLAUDE_EFFORT_LEVELS } from '../claude-effort-levels';
import type { GatewayConfig } from '../config/collect-gateways';
import { createClaudeLaunchFiles } from '../create-claude-launch-files';
import { createLocalScratchDir } from '../create-local-scratch-dir';
import { findClaudeMenu } from '../find-claude-menu';
import { findClaudePermissionMode } from '../find-claude-permission-mode';
import { formatPluginDirArgs } from '../format-plugin-dir-args';
import { buildClaudeConfigSeed } from '../guest/build-claude-config-seed';
import { buildClaudeGuestLaunch } from '../guest/build-claude-guest-launch';
import { buildClaudeProjectSettingsCheck } from '../guest/build-claude-project-settings-check';
import { makeClaudeHeadlessRunner } from '../headless/make-claude-headless-runner';
import { loadClaudeName } from '../load-claude-name';
import { parseClaudeTranscriptLine } from '../parse-claude-transcript-line';
import { planClaudeLineInput } from '../plan-claude-line-input';
import { resolveClaudePermissionMode } from '../resolve-claude-permission-mode';
import { resolveConfiguredPluginDirs } from '../resolve-configured-plugin-dirs';
import { SESSION_SCRATCH_FOLDER } from '../session-scratch-folder';

export interface GatewayAdapter extends AgentAdapter {
  // The gateway runs the Claude CLI, which writes the same transcript.
  readonly parseTranscriptLine: (line: string) => TranscriptRow | null;

  // The gateway runs the Claude CLI, whose TUI takes a line the same way.
  readonly planLineInput: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  // The gateway runs the Claude CLI, whose dialogs draw the same menus.
  readonly findMenu: (screen: string, rows?: number) => ScreenMenu | null;
  readonly profile: AgentProfile;

  // refused before anything is prepared, when the placeholders cannot pair with the broker's
  // header or the settings env would route the CLI around the broker
  readonly findSpawnRefusal: () => DaemonError | null;
  readonly findAuthSelection: () => AuthSelection | null;

  // the guest holds placeholders the broker swaps for the real credential on the host's side,
  // and never the credential helper, which runs on the daemon's machine alone
  readonly planGuestSpawn: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;
  readonly planGuestBridgeFiles: (atc: string) => Readonly<Record<string, string>>;
  readonly planGuestWorkspaceTrust: (root: string) => Readonly<Record<string, string>> | null;

  // The repository's own settings files reach the CLI as well, so a launch
  // behind the target's broker reads them first.
  readonly planProjectSettingsCheck: () => ProjectSettingsCheck;

  // The gateway runs the Claude CLI, whose hook lines it reads as stock
  // Claude does, with no state across a session's lines.
  readonly planHookEvents: (hookEvent: HookEvent) => HookPlan;
}

// The Claude CLI's mode that asks a person before each action.
const MANUAL_PERMISSION_MODE = 'default';

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

// Variables the Claude CLI reads as its own credential beside either
// pairing's variable, plus the one that points it at the session's config
// folder, whose launch value a placeholder would overwrite.
const COMPETING_CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  CLAUDE_CREDENTIAL_VARIABLES.oauthToken,
  'CLAUDE_CONFIG_DIR',
]);

export function createGatewayAdapter(
  gateway: GatewayConfig,
  config: Pick<Config, 'authProfiles'>,
  host: Pick<HostServices, 'atcArgv'>,
  options: ClaudeAdapterOptions = {},
): GatewayAdapter {
  const headlessRun = options.headlessRun ?? null;
  const pluginDirs = resolveConfiguredPluginDirs(gateway.pluginDirs, options.homeDir);

  // The settings file carries the backend's base URL, its environment, its
  // credential helper, and its settings.
  const files = createClaudeLaunchFiles(
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

  // a brokered session's Claude config is fresh, so without an explicit mode the CLI's own
  // default would apply rather than the one the owner's settings set
  const buildGuestModeArgs = (args: readonly string[]): string[] => {
    if (findFlagValue(args, ['--permission-mode']) !== null) {
      return [];
    }

    return [
      '--permission-mode',
      findClaudePermissionMode([], gateway.settings) ?? MANUAL_PERMISSION_MODE,
    ];
  };

  const buildBrokerRefusal = (reason: string): DaemonError =>
    new DaemonError(
      'auth_target_unsupported',
      `gateway '${gateway.id}' takes its credential from a credential broker, ${reason}`,
      { agent: gateway.id },
    );

  // other placeholder variables pass through for tools in the session, except credential
  // variables the CLI reads, which would add a second header the broker never fills
  const findPlaceholderRefusal = (
    env: Readonly<Record<string, string>>,
    profiles: readonly string[],
  ): DaemonError | null => {
    const keys = Object.keys(env);
    const pairings = CREDENTIAL_PAIRINGS.filter((candidate) => keys.includes(candidate.variable));
    const [pairing] = pairings;

    if (pairing === undefined) {
      return buildPlaceholderRefusal(
        `needs ${BEARER_PAIRING.variable} or ${API_KEY_PAIRING.variable} among its placeholder variables, which the broker fills as a bearer authorization header or a raw x-api-key header; it has ${keys.length === 0 ? 'none' : keys.join(', ')}`,
      );
    }

    if (pairings.length > 1) {
      return buildPlaceholderRefusal(
        `cannot set both ${BEARER_PAIRING.variable} and ${API_KEY_PAIRING.variable} as placeholder variables, since the Claude CLI would send both headers and the broker fills one`,
      );
    }

    const competing = keys.find((key) => COMPETING_CREDENTIAL_VARIABLES.has(key));

    if (competing !== undefined) {
      return buildPlaceholderRefusal(
        `cannot use ${competing} as a placeholder variable, since the Claude CLI reads it as its own credential or config folder beside ${pairing.variable}`,
      );
    }

    if (env[pairing.variable] !== BROKER_PLACEHOLDER) {
      return buildPlaceholderRefusal(`needs ${pairing.variable} to hold ${BROKER_PLACEHOLDER}`);
    }

    const resolution = resolveAuthProfiles(config.authProfiles, profiles);

    const hostname = new URL(gateway.baseURL).hostname;

    const rule =
      'resolved' in resolution
        ? resolution.resolved.secrets
            .flatMap((secret) => secret.rules)
            .find((candidate) => candidate.host === hostname)
        : undefined;

    if (rule?.header !== pairing.header || rule.scheme !== pairing.scheme) {
      return buildPlaceholderRefusal(
        `needs a profile that sets ${pairing.description} for ${hostname}, the header ${pairing.variable} fills`,
      );
    }

    return null;
  };

  // The settings file's env block reaches the CLI's own process, so a proxy
  // or CA variable there would route the CLI around the broker.
  const findSettingsEnvConflict = (): DaemonError | null => {
    const settingsEnv = gateway.settings?.['env'];

    const keys = [
      ...Object.keys(gateway.env),
      ...(isRecord(settingsEnv) ? Object.keys(settingsEnv) : []),
    ];

    const variable = keys.find((key) => isBrokerVariable(key));

    if (variable === undefined) {
      return null;
    }

    return new DaemonError(
      'auth_target_unsupported',
      `gateway '${gateway.id}' sets ${variable} in its settings env, which would route around the target's broker`,
      { agent: gateway.id, problem: 'guest_env_conflict', variable },
    );
  };

  const buildPlaceholderRefusal = (problem: string): DaemonError =>
    new DaemonError('auth_placeholder_unsupported', `gateway '${gateway.id}' ${problem}`, {
      agent: gateway.id,
    });

  return {
    id: gateway.id,

    // A headless turn carries the same settings file the terminal spawn does,
    // so it reaches this backend rather than the default one. A gateway whose
    // credential comes through a broker alone runs no headless turn.
    headlessRunner:
      headlessRun === null || isBrokerOnlyGateway(gateway)
        ? null
        : makeClaudeHeadlessRunner(headlessRun, {
            claudeBin: gateway.bin,
            permissionMode: resolveClaudePermissionMode(gateway.args, gateway.settings),
            pluginDir: () => files.writeBridge(),
            pluginDirs,
            settings: () => files.writeSettings(),
          }),

    // The CLI's hooks are authoritative; no screen heuristics needed.
    screenDetector: null,

    parseTranscriptLine: parseClaudeTranscriptLine,
    planLineInput: planClaudeLineInput,
    findMenu: findClaudeMenu,
    takesMessages: true,
    loadName: (source, namedBy, sessionHost) => loadClaudeName(source, namedBy, sessionHost.files),
    canResume: probeTranscriptResumable,
    profile: {
      label: gateway.label,
      kind: 'gateway',
      bin: gateway.bin,
      models,
      spawnOptions: buildGatewaySpawnOptions(gateway.args, models),
      ...(pluginDirs.length === 0 ? {} : { pluginDirs }),
    },

    findSpawnRefusal: () => {
      const auth = gateway.auth;

      if (auth === undefined) {
        return null;
      }

      return (
        findPlaceholderRefusal(auth.placeholderEnv, auth.profiles) ?? findSettingsEnvConflict()
      );
    },

    findAuthSelection: () => {
      const auth = gateway.auth;

      if (auth === undefined) {
        return null;
      }

      return {
        gateway: { id: gateway.id, baseURL: gateway.baseURL, auth },
        profiles: config.authProfiles,
        brokerRequired: isBrokerOnlyGateway(gateway),
      };
    },

    planSpawn: (opts, session?: SessionID) => {
      // started without the broker, the CLI would send whatever credential it holds to the
      // gateway's host; a gateway with a credential helper starts here under that helper
      if (isBrokerOnlyGateway(gateway)) {
        throw buildBrokerRefusal('which only a target that reaches one can give it');
      }

      const modeArgs =
        opts.resume === false ? [] : buildRestoreModeArgs(gateway.args, gateway.settings);

      const scratch =
        session === undefined ? null : createLocalScratchDir(session, options.stateDir);

      return {
        bin: gateway.bin,
        args: buildClaudeArgs(gateway.args, opts, {
          leadArgs: modeArgs,
          scratch,
          settings: files.writeSettings(),
          pluginDir: files.writeBridge(),
          pluginDirs: [...pluginDirs, ...(opts.pluginDirs ?? [])],
        }),
        ...(scratch === null ? {} : { env: { TMPDIR: scratch } }),
      };
    },

    planGuestSpawn: (opts, guest) => {
      if (gateway.auth === undefined) {
        return null;
      }

      if (guest.auth === undefined) {
        throw buildBrokerRefusal('and this session has no broker binding');
      }

      if (guest.atc === null) {
        return null;
      }

      const refusal =
        findPlaceholderRefusal(guest.auth.env, gateway.auth.profiles) ?? findSettingsEnvConflict();

      if (refusal !== null) {
        throw refusal;
      }

      const argv = [guest.atc];
      const settingsPath = `${buildAuthRevisionFolder(guest.auth.revision)}/settings.json`;

      const settings = buildHookSettings(
        {
          id: gateway.id,
          env: {
            ...gateway.env,
            ANTHROPIC_BASE_URL: gateway.baseURL,
            ...guest.auth.profileEnv,
            ...guest.auth.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
          ...(gateway.settings === undefined
            ? {}
            : { settings: buildSettingsWithoutHelper(gateway.settings) }),
        },
        0,
        argv,
      );

      const args = gateway.auth.args ?? gateway.args;
      const approvedAPIKey = findAPIKeyPlaceholder(guest.auth.env);

      // a host-set bearer variable would put a second credential header beside the api key
      const refusedEnv = approvedAPIKey === null ? [] : [BEARER_PAIRING.variable];

      const launch = buildClaudeGuestLaunch(
        guest.directory,
        [
          gateway.bin,
          ...buildClaudeArgs(args, opts, {
            leadArgs: buildGuestModeArgs(args),
            scratch: `${guest.directory}/${SESSION_SCRATCH_FOLDER}`,
            settings: `${guest.directory}/${settingsPath}`,
            pluginDir: `${guest.directory}/atc-bridge`,
            pluginDirs: [],
          }),
        ],
        { refusedEnv },
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
    },

    planGuestBridgeFiles: (atc) => buildGuestBridgeFiles([atc]),

    planGuestWorkspaceTrust: (root) => {
      if (gateway.auth === undefined) {
        return null;
      }

      const approvedAPIKey = findAPIKeyPlaceholder(gateway.auth.placeholderEnv);

      return buildClaudeConfigSeed(root, approvedAPIKey);
    },

    planHookEvents: (hookEvent) => ({ events: [buildClaudeHookEvent(hookEvent)] }),

    planResumeCommand: (cwd, agentSessionID: AgentSessionID | undefined, sessionPluginDirs) => {
      // outside atc the broker never reaches the session
      if (isBrokerOnlyGateway(gateway)) {
        return null;
      }

      const args = [...gateway.args, ...buildRestoreModeArgs(gateway.args, gateway.settings)]
        .map((arg) => ` ${toShellArg(arg)}`)
        .join('');

      // without the settings file the CLI would resume against the default backend
      const settings = toShellArg(files.writeSettings());
      const resume = agentSessionID === undefined ? '' : ` ${agentSessionID}`;
      const plugins = formatPluginDirArgs([...pluginDirs, ...sessionPluginDirs]);

      return `cd ${toShellArg(cwd)} && ${gateway.bin}${args} --settings ${settings}${plugins} --resume${resume}`;
    },

    planProjectSettingsCheck: () => buildClaudeProjectSettingsCheck(gateway.id),
  };
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

// Whether a gateway takes its credential from a broker with no
// credential helper to fall back on, so it starts only behind the broker.
function isBrokerOnlyGateway(gateway: GatewayConfig): boolean {
  return gateway.auth !== undefined && gateway.apiKeyHelper === undefined;
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
    pluginDirs: buildPluginDirsOption(),
  };
}

// The gateway's settings without a credential helper, which a brokered
// session never runs.
function buildSettingsWithoutHelper(
  settings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'apiKeyHelper'));
}

// the CLI asks a person whether to use an api key variable unless its config approves it
function findAPIKeyPlaceholder(env: Readonly<Record<string, string>>): string | null {
  return env[API_KEY_PAIRING.variable] ?? null;
}
