import { randomUUID } from 'node:crypto';
import type { AgentEntry, Config } from '@atc/config';
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
  SpawnOptionSpecs,
  SpawnOptions,
  TerminalInputModes,
} from '@atc/plugin-api';
import {
  buildArgsWithoutFlags,
  buildAuthRevisionFolder,
  findFlagValue,
  probeTranscriptResumable,
} from '@atc/plugin-api';
import type { HookEvent } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import type { AgentSessionID, SessionID, TranscriptRow } from '@atcx/contract';
import { z } from 'zod';
import { buildGuestBridgeFiles } from './bridge/build-guest-bridge-files';
import { buildClaudeArgs } from './build-claude-args';
import { buildClaudeHookEvent } from './build-claude-hook-event';
import { buildHookSettings } from './build-hook-settings';
import type { HookSettingsProfile } from './build-hook-settings';
import { buildPluginDirsOption } from './build-plugin-dirs-option';
import { buildRestoreModeArgs } from './build-restore-mode-args';
import { buildScratchLaunch } from './build-scratch-launch';
import type { ClaudeAdapterOptions } from './claude-adapter-options';
import { CLAUDE_EFFORT_LEVELS } from './claude-effort-levels';
import { createClaudeLaunchFiles } from './create-claude-launch-files';
import { createLocalScratchDir } from './create-local-scratch-dir';
import { findClaudeMenu } from './find-claude-menu';
import { findClaudePermissionMode } from './find-claude-permission-mode';
import { formatPluginDirArgs } from './format-plugin-dir-args';
import { buildClaudeConfigSeed } from './guest/build-claude-config-seed';
import { buildClaudeCredentialsFile } from './guest/build-claude-credentials-file';
import { buildClaudeGuestLaunch } from './guest/build-claude-guest-launch';
import { buildClaudeMCPConfig } from './guest/build-claude-mcp-config';
import { buildClaudeProjectSettingsCheck } from './guest/build-claude-project-settings-check';
import { CLAUDE_CONFIG_BUNDLE_FOLDER } from './guest/claude-config-bundle-folder';
import { loadClaudeConfigBundle } from './guest/load-claude-config-bundle';
import { planCodexHome } from './guest/plan-codex-home';
import { makeClaudeHeadlessRunner } from './headless/make-claude-headless-runner';
import { loadClaudeName } from './load-claude-name';
import { resolveClaudeGlobalConfigPath } from './local-trust/resolve-claude-global-config-path';
import { updateClaudeProjectTrust } from './local-trust/update-claude-project-trust';
import { parseClaudeTranscriptLine } from './parse-claude-transcript-line';
import { planClaudeLineInput } from './plan-claude-line-input';
import { resolveClaudePermissionMode } from './resolve-claude-permission-mode';
import { resolveConfiguredPluginDirs } from './resolve-configured-plugin-dirs';
import { SESSION_SCRATCH_FOLDER } from './session-scratch-folder';

export interface ClaudeAdapter extends AgentAdapter {
  readonly parseTranscriptLine: (line: string) => TranscriptRow | null;

  // Claude's TUI takes a long burst of input as a paste and keeps its
  // newline in the composer, so a line is pasted and then submitted, with a
  // leading slash command's name typed so the command still runs.
  readonly planLineInput: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  // Claude's dialogs draw a `❯` cursor beside their options.
  readonly findMenu: (screen: string, rows?: number) => ScreenMenu | null;
  readonly profile: AgentProfile;

  // with `auth`, Claude signs in with the broker's subscription token on a target that reaches
  // the broker and with its host's own sign-in anywhere else
  readonly findAuthSelection: () => AuthSelection | null;

  // a remote session reports through the atc inside its host, so without one it cannot run there
  readonly planGuestSpawn: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;
  readonly planGuestBridgeFiles: (atc: string) => Readonly<Record<string, string>>;

  // Seeds the config folder of a session that signs in through the target's
  // broker with trust for the clone; any other remote session reads the
  // config of the host's image, which atc never writes.
  readonly planGuestWorkspaceTrust: (root: string) => Readonly<Record<string, string>> | null;

  // The repository's own settings files outrank what the session's user
  // settings hold, so a launch behind the target's broker reads them first.
  readonly planProjectSettingsCheck: () => ProjectSettingsCheck;

  // A session on the daemon's machine reads the user's own Claude config,
  // so trust for the clone is that config's entry for the clone alone.
  readonly updateLocalWorkspaceTrust: (root: string) => Promise<() => Promise<void>>;

  // Claude keeps no state across a session's hook lines.
  readonly planHookEvents: (hookEvent: HookEvent) => HookPlan;
}

// The endpoint Claude Code sends a subscription token to.
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

  // What the generated settings file holds for this entry: its hooks and
  // statusline, its settings, and its environment, with `extraEnv` on top.
  // The entry's environment outranks the settings' own env block.
  const buildSettingsProfile = (
    extraEnv: Readonly<Record<string, string>>,
  ): HookSettingsProfile => {
    const settingsEnv = entry.settings?.['env'];

    const env = {
      ...(isRecord(settingsEnv) ? toStringEntries(settingsEnv) : {}),
      ...entry.env,
      ...extraEnv,
    };

    return {
      id: entry.id,
      env,
      ...(entry.settings === undefined ? {} : { settings: entry.settings }),
    };
  };

  const files = createClaudeLaunchFiles(buildSettingsProfile({}), host.atcArgv, options);

  // A resumed session restores the permission mode the configured
  // arguments or settings set.
  const buildModeArgs = (opts: SpawnOptions): string[] =>
    opts.resume === false ? [] : buildRestoreModeArgs(entry.args, entry.settings);

  // a variable overrides the subscription sign-in or routes the CLI around the target's broker
  const findCredentialOverride = (): DaemonError | null => {
    const settingsEnv = entry.settings?.['env'];

    const sources: readonly (readonly [string, readonly string[]])[] = [
      ['env', Object.keys(entry.env)],
      ['settings.env', isRecord(settingsEnv) ? Object.keys(settingsEnv) : []],
      ['args in --settings', collectInlineSettingsKeys(entry.args)],
    ];

    for (const [source, keys] of sources) {
      const variable = keys.find((key) => isSubscriptionOverrideVariable(key));

      if (variable !== undefined) {
        return new DaemonError(
          'auth_target_unsupported',
          `claude signs in through this target's broker, but agents.${entry.id}.${source === 'args in --settings' ? 'args set' : `${source} sets`} ${variable}${source === 'args in --settings' ? ' in --settings' : ''}, which would override or route around that sign-in`,
          { agent: entry.id, problem: 'guest_env_conflict', variable },
        );
      }
    }

    return null;
  };

  const planSubscriptionGuestSpawn = (
    opts: SpawnOptions,
    directory: string,
    auth: NonNullable<GuestPaths['auth']>,
    argv: readonly string[],
  ): GuestSpawnPlan => {
    // a credential, endpoint or provider variable in the configured settings or the host's
    // environment would keep the CLI from sending the placeholder
    const refusal = findCredentialOverride();

    if (refusal !== null) {
      throw refusal;
    }

    const revisionFolder = buildAuthRevisionFolder(auth.revision);
    const settingsPath = `${revisionFolder}/settings.json`;
    const mcpServers = entry.mcpServers ?? [];
    const atcArgv = opts.atcMCP === true ? argv : null;
    const takesMCP = mcpServers.length > 0 || atcArgv !== null;
    const mcpPath = `${revisionFolder}/mcp.json`;
    const mcpArgs = takesMCP ? ['--mcp-config', `${directory}/${mcpPath}`] : [];
    const bundleKey = randomUUID();
    const scratch = `${directory}/${SESSION_SCRATCH_FOLDER}`;

    // when the profiles send a ChatGPT sign-in too, the Codex CLI the session runs as a tool signs
    // in through the broker, with every variable that would sign it in another way unset
    const codexHome = planCodexHome({
      authProfiles,
      selected: entry.auth?.profiles ?? [],
      guestDir: directory,
      revisionFolder,
      states: auth.oauth ?? {},
    });

    // the configured arguments drop their permission mode, so the mode the session's own user
    // settings set applies
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
        refusedEnv: [...OUTRANKING_VARIABLES],
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
      '.credentials.json': buildClaudeCredentialsFile(),
    };

    // atc's statusline renders the one the bundle's user settings set
    // first, so it mirrors that one's padding.
    const userSettings = bundle['settings.json'];

    const padding =
      typeof userSettings === 'string' ? (parseClaudeStatusLine(userSettings).padding ?? 0) : 0;

    const settings = buildHookSettings(
      buildSettingsProfile({
        ...auth.profileEnv,
        ...auth.env,
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
        ...buildClaudeConfigSeed(null),
        ...Object.fromEntries(
          Object.entries(bundle).map(([path, content]) => [
            `${CLAUDE_CONFIG_BUNDLE_FOLDER}/${bundleKey}/${path}`,
            content,
          ]),
        ),
        ...codexHome.files,
        ...buildGuestBridgeFiles(argv),
      },
      env: { ...launch.env, ...codexHome.env, ...auth.profileEnv, ...auth.env },
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

    // Claude's hooks are authoritative; no screen heuristics needed.
    screenDetector: null,

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

    // A session's scratch folder lies under its own folder in atc's state
    // folder, and is its temporary folder too.
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
        return planSubscriptionGuestSpawn(opts, guest.directory, guest.auth, argv);
      }

      const scratch = `${guest.directory}/${SESSION_SCRATCH_FOLDER}`;
      const atcArgv = opts.atcMCP === true ? argv : null;
      const mcpArgs = atcArgv === null ? [] : ['--mcp-config', `${guest.directory}/mcp.json`];

      const launch = buildScratchLaunch(scratch, [
        entry.bin,
        ...buildClaudeArgs(entry.args, opts, {
          leadArgs: [...mcpArgs, ...buildModeArgs(opts)],
          scratch,
          settings: `${guest.directory}/settings.json`,
          pluginDir: `${guest.directory}/atc-bridge`,
          pluginDirs: [],
        }),
      ]);

      const settings = buildHookSettings(buildSettingsProfile({}), 0, argv);

      return {
        ...launch,
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

    planGuestBridgeFiles: (atc) => buildGuestBridgeFiles([atc]),

    planGuestWorkspaceTrust: (root) => {
      if (entry.auth === undefined) {
        return null;
      }

      return buildClaudeConfigSeed(root);
    },

    planProjectSettingsCheck: () => buildClaudeProjectSettingsCheck(entry.id),

    updateLocalWorkspaceTrust: (root) =>
      updateClaudeProjectTrust(resolveClaudeGlobalConfigPath(options.homeDir), root),

    planHookEvents: (hookEvent) => ({ events: [buildClaudeHookEvent(hookEvent)] }),

    // the generated settings file sits on the daemon's machine, so it travels only for an entry
    // that sets its own settings or environment
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

// The string values of an object, which is all a session's environment holds.
function toStringEntries(value: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

// An inline `--settings` argument's env block; any other shape holds no
// variables.
const INLINE_SETTINGS_SCHEMA = z.object({ env: z.record(z.string(), z.unknown()) });

// The variables an inline `--settings` argument sets in its env block.
function collectInlineSettingsKeys(args: readonly string[]): string[] {
  const inline = findFlagValue(args, ['--settings']);

  if (inline === null) {
    return [];
  }

  let json: unknown;

  try {
    json = JSON.parse(inline);
  } catch {
    return [];
  }

  const parsed = INLINE_SETTINGS_SCHEMA.safeParse(json);

  return parsed.success ? Object.keys(parsed.data.env) : [];
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
    pluginDirs: buildPluginDirsOption(),
  };
}

// A binary name or path that needs no quoting stays bare, so the default
// entry resumes with plain `claude`; anything else is quoted as one word.
function formatShellWord(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : toShellArg(value);
}
