import { randomUUID } from 'node:crypto';
import type { AgentEntry, Config } from '@atc/config';
import { buildTelemetryEnv } from '@atc/config';
import { parseClaudeStatusLine } from '@atc/config/claude-statusline';
import { resolveAgentHome } from '@atc/config/host';
import {
  BROKER_PLACEHOLDER,
  CLAUDE_CREDENTIAL_VARIABLES,
  OUTRANKING_VARIABLES,
  isRecord,
  isSubscriptionOverrideVariable,
  toShellArg,
} from '@atc/core';
import type {
  AgentAdapter,
  AgentProfile,
  AuthSelection,
  GuestFile,
  GuestPaths,
  GuestSpawnPlan,
  HookPlan,
  HostServices,
  LineInputStep,
  ProjectSettingsCheck,
  ScreenMenu,
  SpawnOptions,
  TerminalInputModes,
} from '@atc/plugin-api';
import {
  buildArgsWithoutFlags,
  buildAuthRevisionFolder,
  probeTranscriptResumable,
} from '@atc/plugin-api';
import type { HookEvent } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import type { AgentSessionID, SessionID, TranscriptRow } from '@atcx/contract';
import { buildGuestBridgeFiles } from './bridge/build-guest-bridge-files';
import type { ClaudeAdapterOptions } from './claude-adapter-options';
import { createClaudeLaunchFiles } from './create-claude-launch-files';
import { ATC_MCP_ENV } from './guest/atc-mcp-env';
import { buildClaudeConfigSeed } from './guest/build-claude-config-seed';
import { buildClaudeCredentialsFile } from './guest/build-claude-credentials-file';
import { buildClaudeGuestLaunch } from './guest/build-claude-guest-launch';
import { buildClaudeMCPConfig } from './guest/build-claude-mcp-config';
import { buildClaudeProjectSettingsCheck } from './guest/build-claude-project-settings-check';
import { buildGuestSettingsPath } from './guest/build-guest-settings-path';
import { CLAUDE_CONFIG_BUNDLE_FOLDER } from './guest/claude-config-bundle-folder';
import { loadClaudeConfigBundle } from './guest/load-claude-config-bundle';
import { parseInlineSettings } from './guest/parse-inline-settings';
import { planCodexHome } from './guest/plan-codex-home';
import { toStringEntries } from './guest/to-string-entries';
import { makeClaudeHeadlessRunner } from './headless/make-claude-headless-runner';
import { buildClaudeHookEvent } from './hooks/build-claude-hook-event';
import { buildHookSettings } from './hooks/build-hook-settings';
import type { HookSettingsProfile } from './hooks/build-hook-settings';
import { buildClaudeArgs } from './launch-args/build-claude-args';
import { buildClaudeSpawnOptions } from './launch-args/build-claude-spawn-options';
import { buildRestoreModeArgs } from './launch-args/build-restore-mode-args';
import { formatShellWord } from './launch-args/format-shell-word';
import { resolveClaudeGlobalConfigPath } from './local-trust/resolve-claude-global-config-path';
import { updateClaudeProjectTrust } from './local-trust/update-claude-project-trust';
import { formatPluginDirArgs } from './plugin/format-plugin-dir-args';
import { resolveConfiguredPluginDirs } from './plugin/resolve-configured-plugin-dirs';
import { buildScratchLaunch } from './scratch/build-scratch-launch';
import { createLocalScratchDir } from './scratch/create-local-scratch-dir';
import { SESSION_SCRATCH_FOLDER } from './scratch/session-scratch-folder';
import { findClaudeMenu } from './screen/find-claude-menu';
import { findClaudePermissionMode } from './screen/find-claude-permission-mode';
import { pickClaudeAttention } from './screen/pick-claude-attention';
import { planClaudeLineInput } from './screen/plan-claude-line-input';
import { resolveClaudePermissionMode } from './screen/resolve-claude-permission-mode';
import { loadClaudeName } from './transcript/load-claude-name';
import { parseClaudeTranscriptLine } from './transcript/parse-claude-transcript-line';

const SIGN_IN_FILE = 'claude-oauth-token';

export interface ClaudeAdapter extends AgentAdapter {
  readonly parseTranscriptLine: (line: string) => TranscriptRow | null;

  // Claude's TUI treats a long burst of input as a paste and keeps its newline in the composer.
  // A slash command's name must be typed so the command still runs.
  readonly planLineInput: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  readonly findMenu: (screen: string, rows?: number) => ScreenMenu | null;
  readonly profile: AgentProfile;

  readonly findAuthSelection: () => AuthSelection | null;

  readonly findGuestEnvConflict: (kind: 'broker' | 'routed' | 'stored-token') => string | null;
  readonly signInFile: typeof SIGN_IN_FILE;

  readonly planGuestSpawn: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;
  readonly planGuestBridgeFiles: (
    atc: string,
    writtenAt: number,
  ) => Readonly<Record<string, string>>;

  readonly planGuestWorkspaceTrust: (
    root: string,
    guestDirectory: string,
  ) => Readonly<Record<string, string>> | null;

  readonly planProjectSettingsCheck: () => ProjectSettingsCheck;

  // Claude 2.1.328 asks for trust on each `--add-dir` folder, so a local
  // session's scratch folder is trusted in the user's own Claude config for
  // the session's life.
  readonly trustLocalScratch: (scratch: string) => Promise<void>;

  readonly updateLocalWorkspaceTrust: (root: string) => Promise<() => Promise<void>>;

  readonly planHookEvents: (hookEvent: HookEvent) => HookPlan;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com';

export function createClaudeAdapter(
  entry: AgentEntry,
  config: Pick<Config, 'authProfiles'>,
  host: Pick<HostServices, 'atcArgv'>,
  options: ClaudeAdapterOptions = {},
): ClaudeAdapter {
  const headlessRun = options.headlessRun ?? null;
  const authProfiles = config.authProfiles;
  const pluginDirs = resolveConfiguredPluginDirs(entry.pluginDirs, options.homeDir);

  const buildSettingsProfile = (
    sessionEnv: Readonly<Record<string, string>>,
    extraEnv: Readonly<Record<string, string>>,
  ): HookSettingsProfile => {
    const settingsEnv = entry.settings?.['env'];

    const env = {
      ...(isRecord(settingsEnv) ? toStringEntries(settingsEnv) : {}),
      ...entry.env,
      ...sessionEnv,
      ...extraEnv,
    };

    return {
      id: entry.id,
      env,
      ...(entry.settings === undefined ? {} : { settings: entry.settings }),
    };
  };

  const files = createClaudeLaunchFiles(buildSettingsProfile({}, {}), host.atcArgv, options);

  const buildModeArgs = (opts: SpawnOptions): string[] =>
    opts.resume === false ? [] : buildRestoreModeArgs(entry.args, entry.settings);

  const findGuestEnvConflict = (kind: 'broker' | 'routed' | 'stored-token'): string | null => {
    if (kind === 'broker' && entry.auth === undefined) {
      return null;
    }

    const settingsEnv = entry.settings?.['env'];
    const inline = parseInlineSettings(entry.args);

    const keys = [
      ...Object.keys(entry.env),
      ...(isRecord(settingsEnv) ? Object.keys(settingsEnv) : []),
      ...Object.keys(inline.env),
    ];

    const variable = keys.find((key) => isSubscriptionOverrideVariable(key));

    if (variable !== undefined) {
      return variable;
    }

    if (kind === 'broker') {
      return null;
    }

    return entry.settings?.['apiKeyHelper'] === undefined && !inline.hasAPIKeyHelper
      ? null
      : 'settings.apiKeyHelper';
  };

  const planRoutedEnv = (
    auth: NonNullable<GuestPaths['auth']>,
  ): {
    readonly routed: boolean;
    readonly env: Readonly<Record<string, string>>;
    readonly routedNames: ReadonlySet<string>;
  } => {
    if (auth.routes === undefined) {
      return { routed: false, env: auth.env, routedNames: new Set() };
    }

    const profile = entry.auth?.profiles[0];
    const route = profile === undefined ? undefined : auth.routes[profile];

    if (route === undefined) {
      throw new DaemonError(
        'auth_target_unsupported',
        `agent '${entry.id}' has no route for its auth profile on this target`,
        { agent: entry.id, problem: 'no_route' },
      );
    }

    const { [CLAUDE_CREDENTIAL_VARIABLES.oauthToken]: _oauthToken, ...placeholders } = auth.env;

    return {
      routed: true,
      env: {
        ...placeholders,
        [CLAUDE_CREDENTIAL_VARIABLES.baseURL]: route,
        [CLAUDE_CREDENTIAL_VARIABLES.authToken]: BROKER_PLACEHOLDER,
      },
      routedNames: new Set([
        CLAUDE_CREDENTIAL_VARIABLES.baseURL,
        CLAUDE_CREDENTIAL_VARIABLES.authToken,
      ]),
    };
  };

  const planSubscriptionGuestSpawn = (
    opts: SpawnOptions,
    guest: GuestPaths,
    auth: NonNullable<GuestPaths['auth']>,
    argv: readonly string[],
  ): GuestSpawnPlan => {
    const directory = guest.directory;
    const routed = planRoutedEnv(auth);
    const revisionFolder = buildAuthRevisionFolder(auth.revision);
    const settingsPath = `${revisionFolder}/settings.json`;
    const mcpServers = entry.mcpServers ?? [];
    const atcArgv = opts.atcMCP === true ? argv : null;
    const takesMCP = mcpServers.length > 0 || atcArgv !== null;
    const mcpPath = `${revisionFolder}/mcp.json`;
    const mcpArgs = takesMCP ? ['--mcp-config', `${directory}/${mcpPath}`] : [];
    const bundleKey = randomUUID();
    const scratch = `${directory}/${SESSION_SCRATCH_FOLDER}`;

    const codexHome = routed.routed
      ? { files: {}, env: {}, unsetEnv: [] }
      : planCodexHome({
          authProfiles,
          selected: entry.auth?.profiles ?? [],
          guestDir: directory,
          revisionFolder,
          states: auth.oauth ?? {},
          telemetryHost: auth.telemetryHost ?? null,
        });

    const telemetryEnv =
      auth.telemetryHost === undefined ? {} : buildTelemetryEnv(auth.telemetryHost);

    const launch = buildClaudeGuestLaunch(
      directory,
      [
        entry.bin,
        ...buildClaudeArgs(buildArgsWithoutFlags(entry.args, ['--permission-mode']), opts, {
          leadArgs: mcpArgs,
          scratch,
          settings: `${directory}/${settingsPath}`,
          pluginDir: `${directory}/atc-bridge`,
          pluginDirs: [],
        }),
      ],
      {
        refusedEnv: [...OUTRANKING_VARIABLES].filter((name) => !routed.routedNames.has(name)),
        bundleKey,
        unsetEnv: codexHome.unsetEnv,
      },
    );

    const bundle: Record<string, GuestFile> = {
      ...loadClaudeConfigBundle(
        resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude', options.homeDir),
        launch.env.CLAUDE_CONFIG_DIR,
        options.homeDir,
      ),
      ...(routed.routed ? {} : { '.credentials.json': buildClaudeCredentialsFile() }),
    };

    const userSettings = bundle['settings.json'];

    const padding =
      typeof userSettings === 'string' ? (parseClaudeStatusLine(userSettings).padding ?? 0) : 0;

    const settings = buildHookSettings(
      buildSettingsProfile(guest.sessionEnv ?? {}, {
        ...auth.profileEnv,
        ...telemetryEnv,
        ...routed.env,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }),
      padding,
      argv,
    );

    return {
      bin: launch.bin,
      args: launch.args,
      scratch,
      files: {
        [settingsPath]: JSON.stringify(settings, null, 2),
        ...(takesMCP
          ? { [mcpPath]: JSON.stringify(buildClaudeMCPConfig(mcpServers, atcArgv), null, 2) }
          : {}),
        ...buildClaudeConfigSeed(null, null, scratch),
        ...Object.fromEntries(
          Object.entries(bundle).map(([path, content]) => [
            `${CLAUDE_CONFIG_BUNDLE_FOLDER}/${bundleKey}/${path}`,
            content,
          ]),
        ),
        ...codexHome.files,
        ...buildGuestBridgeFiles(argv),
      },
      env: {
        ...launch.env,
        ...(atcArgv === null ? {} : ATC_MCP_ENV),
        ...codexHome.env,
        ...auth.profileEnv,
        ...telemetryEnv,
        ...routed.env,
      },
    };
  };

  const planStoredTokenGuestSpawn = (
    opts: SpawnOptions,
    guest: GuestPaths,
    signIn: string,
    argv: readonly string[],
  ): GuestSpawnPlan => {
    const scratch = `${guest.directory}/${SESSION_SCRATCH_FOLDER}`;
    const atcArgv = opts.atcMCP === true ? argv : null;
    const mcpArgs = atcArgv === null ? [] : ['--mcp-config', `${guest.directory}/mcp.json`];

    const launch = buildClaudeGuestLaunch(
      guest.directory,
      [
        entry.bin,
        ...buildClaudeArgs(entry.args, opts, {
          leadArgs: [...mcpArgs, ...buildModeArgs(opts)],
          scratch,
          settings: buildGuestSettingsPath(guest.directory),
          pluginDir: `${guest.directory}/atc-bridge`,
          pluginDirs: [],
        }),
      ],
      { tokenFile: `${signIn}/${SIGN_IN_FILE}`, refusedEnv: [...OUTRANKING_VARIABLES] },
    );

    const settings = buildHookSettings(buildSettingsProfile(guest.sessionEnv ?? {}, {}), 0, argv);

    return {
      bin: launch.bin,
      args: launch.args,
      scratch,
      files: {
        'settings.json': JSON.stringify(settings, null, 2),
        ...(atcArgv === null
          ? {}
          : { 'mcp.json': JSON.stringify(buildClaudeMCPConfig([], atcArgv), null, 2) }),
        ...buildClaudeConfigSeed(null, null, scratch),
        ...buildGuestBridgeFiles(argv),
      },
      env: { ...launch.env, ...(atcArgv === null ? {} : ATC_MCP_ENV) },
    };
  };

  return {
    id: entry.id,
    headlessRunner:
      headlessRun === null
        ? null
        : makeClaudeHeadlessRunner(headlessRun, {
            claudeBin: entry.bin,
            permissionMode: resolveClaudePermissionMode(entry.args, entry.settings),
            pluginDir: () => files.writeBridge(),
            pluginDirs,
            settings: () => files.writeSettings(),
          }),

    screenDetector: { detectAttention: pickClaudeAttention, untilAgentStart: true },

    parseTranscriptLine: parseClaudeTranscriptLine,
    planLineInput: planClaudeLineInput,
    findMenu: findClaudeMenu,
    loadName: (source, namedBy, sessionHost) => loadClaudeName(source, namedBy, sessionHost.files),
    canResume: probeTranscriptResumable,
    profile: {
      label: entry.label,
      kind: 'claude',
      bin: entry.bin,
      models: null,
      spawnOptions: buildClaudeSpawnOptions(entry.args),
      ...(pluginDirs.length === 0 ? {} : { pluginDirs }),
    },
    takesMessages: true,
    takesAtcMCP: true,

    planSpawn: (opts, session?: SessionID) => {
      const scratch =
        session === undefined ? null : createLocalScratchDir(session, options.stateDir);

      return {
        bin: entry.bin,
        args: buildClaudeArgs(entry.args, opts, {
          leadArgs: buildModeArgs(opts),
          scratch,
          settings: files.writeSettings(),
          pluginDir: files.writeBridge(),
          pluginDirs: [...pluginDirs, ...(opts.pluginDirs ?? [])],
        }),
        ...(scratch === null ? {} : { env: { TMPDIR: scratch }, scratch }),
      };
    },

    findGuestEnvConflict,

    signInFile: SIGN_IN_FILE,

    findAuthSelection: () => {
      const auth = entry.auth;

      if (auth === undefined) {
        return null;
      }

      return {
        gateway: {
          id: entry.id,
          baseURL: ANTHROPIC_API_URL,
          auth: {
            profiles: auth.profiles,
            placeholderEnv: {
              ...auth.placeholderEnv,
              [CLAUDE_CREDENTIAL_VARIABLES.oauthToken]: BROKER_PLACEHOLDER,
            },
          },
        },
        profiles: authProfiles,
        brokerRequired: false,
      };
    },

    planGuestSpawn: (opts, guest) => {
      if (guest.atc === null) {
        return null;
      }

      const argv = [guest.atc];

      if (guest.auth !== undefined) {
        return planSubscriptionGuestSpawn(opts, guest, guest.auth, argv);
      }

      if (guest.signIn !== undefined) {
        return planStoredTokenGuestSpawn(opts, guest, guest.signIn.directory, argv);
      }

      const scratch = `${guest.directory}/${SESSION_SCRATCH_FOLDER}`;
      const atcArgv = opts.atcMCP === true ? argv : null;
      const mcpArgs = atcArgv === null ? [] : ['--mcp-config', `${guest.directory}/mcp.json`];

      const launch = buildScratchLaunch(scratch, [
        entry.bin,
        ...buildClaudeArgs(entry.args, opts, {
          leadArgs: [...mcpArgs, ...buildModeArgs(opts)],
          scratch,
          settings: buildGuestSettingsPath(guest.directory),
          pluginDir: `${guest.directory}/atc-bridge`,
          pluginDirs: [],
        }),
      ]);

      const settings = buildHookSettings(buildSettingsProfile(guest.sessionEnv ?? {}, {}), 0, argv);

      return {
        ...launch,
        env: { ...launch.env, ...(atcArgv === null ? {} : ATC_MCP_ENV) },
        scratch,
        files: {
          'settings.json': JSON.stringify(settings, null, 2),
          ...(atcArgv === null
            ? {}
            : { 'mcp.json': JSON.stringify(buildClaudeMCPConfig([], atcArgv), null, 2) }),
          ...buildGuestBridgeFiles(argv),
        },
      };
    },

    planGuestBridgeFiles: (atc, writtenAt) => buildGuestBridgeFiles([atc], writtenAt),

    planGuestWorkspaceTrust: (root, guestDirectory) => {
      if (entry.auth === undefined) {
        return null;
      }

      return buildClaudeConfigSeed(root, null, `${guestDirectory}/${SESSION_SCRATCH_FOLDER}`);
    },

    planProjectSettingsCheck: () => buildClaudeProjectSettingsCheck(entry.id),

    trustLocalScratch: async (scratch) => {
      await updateClaudeProjectTrust(resolveClaudeGlobalConfigPath(options.homeDir), scratch);
    },

    updateLocalWorkspaceTrust: (root) =>
      updateClaudeProjectTrust(resolveClaudeGlobalConfigPath(options.homeDir), root),

    planHookEvents: (hookEvent) => ({ events: [buildClaudeHookEvent(hookEvent)] }),

    planResumeCommand: (cwd, agentSessionID: AgentSessionID | undefined, sessionPluginDirs) => {
      const configured = findClaudePermissionMode(entry.args, entry.settings);
      const mode = configured === null ? '' : ` --permission-mode ${toShellArg(configured)}`;
      const resume = agentSessionID === undefined ? '' : ` ${agentSessionID}`;

      const settings =
        entry.settings === undefined && Object.keys(entry.env).length === 0
          ? ''
          : ` --settings ${toShellArg(files.writeSettings())}`;

      const plugins = formatPluginDirArgs([...pluginDirs, ...sessionPluginDirs]);

      return `cd ${toShellArg(cwd)} && ${formatShellWord(entry.bin)}${mode}${settings}${plugins} --resume${resume}`;
    },
  };
}
