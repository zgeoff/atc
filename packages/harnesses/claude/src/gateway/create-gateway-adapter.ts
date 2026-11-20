import { join, resolve } from 'node:path';
import type { Config } from '@atc/config';
import { buildTelemetryEnv, resolveAuthProfiles } from '@atc/config';
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
import type { AgentSessionID, SessionID, TranscriptRow } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import { buildGuestBridgeFiles } from '../bridge/build-guest-bridge-files';
import type { ClaudeAdapterOptions } from '../claude-adapter-options';
import type { GatewayConfig } from '../config/collect-gateways';
import { createClaudeLaunchFiles } from '../create-claude-launch-files';
import { ATC_MCP_ENV } from '../guest/atc-mcp-env';
import { buildClaudeConfigSeed } from '../guest/build-claude-config-seed';
import { buildClaudeGuestLaunch } from '../guest/build-claude-guest-launch';
import { buildClaudeMCPConfig } from '../guest/build-claude-mcp-config';
import { buildClaudeProjectSettingsCheck } from '../guest/build-claude-project-settings-check';
import { makeClaudeHeadlessRunner } from '../headless/make-claude-headless-runner';
import { buildClaudeHookEvent } from '../hooks/build-claude-hook-event';
import { buildHookSettings } from '../hooks/build-hook-settings';
import { buildClaudeArgs } from '../launch-args/build-claude-args';
import { buildRestoreModeArgs } from '../launch-args/build-restore-mode-args';
import { CLAUDE_EFFORT_LEVELS } from '../launch-args/claude-effort-levels';
import { resolveClaudeGlobalConfigPath } from '../local-trust/resolve-claude-global-config-path';
import { updateClaudeProjectTrust } from '../local-trust/update-claude-project-trust';
import { buildPluginDirsOption } from '../plugin/build-plugin-dirs-option';
import { formatPluginDirArgs } from '../plugin/format-plugin-dir-args';
import { resolveConfiguredPluginDirs } from '../plugin/resolve-configured-plugin-dirs';
import { createLocalScratchDir } from '../scratch/create-local-scratch-dir';
import { SESSION_SCRATCH_FOLDER } from '../scratch/session-scratch-folder';
import { findClaudeMenu } from '../screen/find-claude-menu';
import { findClaudePermissionMode } from '../screen/find-claude-permission-mode';
import { pickClaudeAttention } from '../screen/pick-claude-attention';
import { planClaudeLineInput } from '../screen/plan-claude-line-input';
import { resolveClaudePermissionMode } from '../screen/resolve-claude-permission-mode';
import { loadClaudeName } from '../transcript/load-claude-name';
import { parseClaudeTranscriptLine } from '../transcript/parse-claude-transcript-line';

export interface GatewayAdapter extends AgentAdapter {
  readonly parseTranscriptLine: (line: string) => TranscriptRow | null;

  readonly planLineInput: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  readonly findMenu: (screen: string, rows?: number) => ScreenMenu | null;
  readonly profile: AgentProfile;

  readonly findSpawnRefusal: () => AtcError | null;
  readonly findAuthSelection: () => AuthSelection | null;

  readonly planGuestSpawn: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;
  readonly planGuestBridgeFiles: (
    atc: string,
    writtenAt: number,
  ) => Readonly<Record<string, string>>;
  readonly planGuestWorkspaceTrust: (
    root: string,
    guestDirectory: string,
  ) => Readonly<Record<string, string>> | null;

  // Claude 2.1.328 asks for trust on each `--add-dir` folder, so a local
  // session's scratch folder is trusted in the config the CLI reads.
  readonly trustLocalScratch: (scratch: string) => Promise<void>;

  readonly planProjectSettingsCheck: () => ProjectSettingsCheck;

  readonly planHookEvents: (hookEvent: HookEvent) => HookPlan;
}

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

// The Claude CLI reads these variables as its own credential, which would add a second header
// the broker never fills. A placeholder would overwrite the session's config folder value.
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

  // The CLI starts in the session's directory, so a relative config folder would resolve
  // differently there than in the daemon.
  const configuredConfigDir = gateway.env['CLAUDE_CONFIG_DIR'];

  const localConfigDir =
    configuredConfigDir === undefined || configuredConfigDir === ''
      ? null
      : resolve(configuredConfigDir);

  const files = createClaudeLaunchFiles(
    {
      id: gateway.id,
      env: {
        ANTHROPIC_BASE_URL: gateway.baseURL,
        ...gateway.env,
        ...(localConfigDir === null ? {} : { CLAUDE_CONFIG_DIR: localConfigDir }),
      },
      ...(gateway.apiKeyHelper === undefined ? {} : { apiKeyHelper: gateway.apiKeyHelper }),
      ...(gateway.settings === undefined ? {} : { settings: gateway.settings }),
    },
    host.atcArgv,
    options,
  );

  const models = pickModels(gateway.env);

  // A brokered session starts with a fresh Claude config, so the CLI would use its own default
  // mode instead of the one the owner's settings set.
  const buildGuestModeArgs = (args: readonly string[]): string[] => {
    if (findFlagValue(args, ['--permission-mode']) !== null) {
      return [];
    }

    return [
      '--permission-mode',
      findClaudePermissionMode([], gateway.settings) ?? MANUAL_PERMISSION_MODE,
    ];
  };

  const buildBrokerRefusal = (reason: string): AtcError =>
    new AtcError(
      'auth_target_unsupported',
      `gateway '${gateway.id}' takes its credential from a credential broker, ${reason}`,
      { agent: gateway.id },
    );

  const findPlaceholderRefusal = (
    env: Readonly<Record<string, string>>,
    profiles: readonly string[],
  ): AtcError | null => {
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

  // The settings env block reaches the CLI's own process, so a proxy or CA variable there
  // would route the CLI around the broker.
  const findSettingsEnvConflict = (): AtcError | null => {
    const settingsEnv = gateway.settings?.['env'];

    const keys = [
      ...Object.keys(gateway.env),
      ...(isRecord(settingsEnv) ? Object.keys(settingsEnv) : []),
    ];

    const variable = keys.find((key) => isBrokerVariable(key));

    if (variable === undefined) {
      return null;
    }

    return new AtcError(
      'auth_target_unsupported',
      `gateway '${gateway.id}' sets ${variable} in its settings env, which would route around the target's broker`,
      { agent: gateway.id, problem: 'guest_env_conflict', variable },
    );
  };

  const buildPlaceholderRefusal = (problem: string): AtcError =>
    new AtcError('auth_placeholder_unsupported', `gateway '${gateway.id}' ${problem}`, {
      agent: gateway.id,
    });

  return {
    id: gateway.id,

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

    screenDetector: { detectAttention: pickClaudeAttention, untilAgentStart: true },

    parseTranscriptLine: parseClaudeTranscriptLine,
    planLineInput: planClaudeLineInput,
    findMenu: findClaudeMenu,
    takesMessages: true,
    takesAtcMCP: true,
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

    findGuestEnvConflict: (kind) => (kind === 'broker' ? null : 'baseURL'),

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
        ...(scratch === null ? {} : { env: { TMPDIR: scratch }, scratch }),
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
      const revisionFolder = buildAuthRevisionFolder(guest.auth.revision);

      const telemetryEnv =
        guest.auth.telemetryHost === undefined ? {} : buildTelemetryEnv(guest.auth.telemetryHost);

      const settingsPath = `${revisionFolder}/settings.json`;
      const atcArgv = opts.atcMCP === true ? argv : null;
      const mcpPath = `${revisionFolder}/mcp.json`;
      const mcpArgs = atcArgv === null ? [] : ['--mcp-config', `${guest.directory}/${mcpPath}`];

      const settings = buildHookSettings(
        {
          id: gateway.id,
          env: {
            ...gateway.env,
            ...guest.sessionEnv,
            ANTHROPIC_BASE_URL: gateway.baseURL,
            ...guest.auth.profileEnv,
            ...telemetryEnv,
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

      // A host-set bearer variable would add a second credential header beside the API key.
      const refusedEnv = approvedAPIKey === null ? [] : [BEARER_PAIRING.variable];

      const launch = buildClaudeGuestLaunch(
        guest.directory,
        [
          gateway.bin,
          ...buildClaudeArgs(args, opts, {
            leadArgs: [...mcpArgs, ...buildGuestModeArgs(args)],
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
          ...(atcArgv === null
            ? {}
            : { [mcpPath]: JSON.stringify(buildClaudeMCPConfig([], atcArgv), null, 2) }),
          ...buildClaudeConfigSeed(
            null,
            approvedAPIKey,
            `${guest.directory}/${SESSION_SCRATCH_FOLDER}`,
          ),
          ...buildGuestBridgeFiles(argv),
        },
        env: {
          ...launch.env,
          ...(atcArgv === null ? {} : ATC_MCP_ENV),
          ...guest.auth.profileEnv,
          ...telemetryEnv,
          ...guest.auth.env,
        },
      };
    },

    planGuestBridgeFiles: (atc, writtenAt) => buildGuestBridgeFiles([atc], writtenAt),

    planGuestWorkspaceTrust: (root, guestDirectory) => {
      if (gateway.auth === undefined) {
        return null;
      }

      const approvedAPIKey = findAPIKeyPlaceholder(gateway.auth.placeholderEnv);

      return buildClaudeConfigSeed(
        root,
        approvedAPIKey,
        `${guestDirectory}/${SESSION_SCRATCH_FOLDER}`,
      );
    },

    trustLocalScratch: async (scratch) => {
      const configPath =
        localConfigDir === null
          ? resolveClaudeGlobalConfigPath(options.homeDir)
          : join(localConfigDir, '.claude.json');

      await updateClaudeProjectTrust(configPath, scratch);
    },

    planHookEvents: (hookEvent) => ({ events: [buildClaudeHookEvent(hookEvent)] }),

    planResumeCommand: (cwd, agentSessionID: AgentSessionID | undefined, sessionPluginDirs) => {
      if (isBrokerOnlyGateway(gateway)) {
        return null;
      }

      const args = [...gateway.args, ...buildRestoreModeArgs(gateway.args, gateway.settings)]
        .map((arg) => ` ${toShellArg(arg)}`)
        .join('');

      const settings = toShellArg(files.writeSettings());
      const resume = agentSessionID === undefined ? '' : ` ${agentSessionID}`;
      const plugins = formatPluginDirArgs([...pluginDirs, ...sessionPluginDirs]);

      return `cd ${toShellArg(cwd)} && ${gateway.bin}${args} --settings ${settings}${plugins} --resume${resume}`;
    },

    planProjectSettingsCheck: () => buildClaudeProjectSettingsCheck(gateway.id),
  };
}

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

function isBrokerOnlyGateway(gateway: GatewayConfig): boolean {
  return gateway.auth !== undefined && gateway.apiKeyHelper === undefined;
}

const GATEWAY_TIERS = ['opus', 'sonnet', 'haiku'];

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

function buildSettingsWithoutHelper(
  settings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'apiKeyHelper'));
}

// the CLI asks a person whether to use an api key variable unless its config approves it
function findAPIKeyPlaceholder(env: Readonly<Record<string, string>>): string | null {
  return env[API_KEY_PAIRING.variable] ?? null;
}
