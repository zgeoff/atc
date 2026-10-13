import { randomUUID } from 'node:crypto';
import type { AgentEntry } from '@atc/config/agent-entry';
import type { Config } from '@atc/config/config';
import { parseClaudeStatusLine } from '@atc/config/parse-claude-statusline';
import { resolveAgentHome } from '@atc/config/resolve-agent-home';
import type { AgentID } from '@atc/core/agent-id';
import type { AgentSessionID } from '@atc/core/agent-session-id';
import { BROKER_PLACEHOLDER } from '@atc/core/broker-placeholder';
import { CLAUDE_CREDENTIAL_VARIABLES } from '@atc/core/claude-credential-variables';
import { isRecord } from '@atc/core/is-record';
import { isSubscriptionOverrideVariable } from '@atc/core/is-subscription-override-variable';
import { OUTRANKING_VARIABLES } from '@atc/core/outranking-variables';
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
import { buildArgsWithoutFlags } from '@atc/plugin-api/harness/build-args-without-flags';
import { buildAuthRevisionFolder } from '@atc/plugin-api/harness/build-auth-revision-folder';
import { canResumeFromTranscript } from '@atc/plugin-api/harness/can-resume-from-transcript';
import { findFlagValue } from '@atc/plugin-api/harness/find-flag-value';
import type { HostServices } from '@atc/plugin-api/host-services';
import { DaemonError } from '@atc/protocol/daemon-error';
import type { HookEvent } from '@atc/protocol/hook-event';
import { z } from 'zod';
import { buildGuestBridgeFiles } from './bridge/build-guest-bridge-files';
import { buildClaudeArgs } from './build-claude-args';
import { buildClaudeHookEvent } from './build-claude-hook-event';
import { buildHookSettings } from './build-hook-settings';
import type { HookSettingsProfile } from './build-hook-settings';
import { buildRestoreModeArgs } from './build-restore-mode-args';
import { buildScratchLaunch } from './build-scratch-launch';
import type { ClaudeAdapterOptions } from './claude-adapter-options';
import { CLAUDE_EFFORT_LEVELS } from './claude-effort-levels';
import { ClaudeLaunchFiles } from './claude-launch-files';
import { createLocalScratchDir } from './create-local-scratch-dir';
import { findClaudePermissionMode } from './find-claude-permission-mode';
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
import { SESSION_SCRATCH_FOLDER } from './session-scratch-folder';

/**
 * The Claude Code adapter: spawn arguments, `--settings` instrumentation,
 * resume semantics, transcript name-pulling, and statusline chaining.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id: AgentID;

  readonly headlessRunner: HeadlessRunner | null;

  // Claude's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  readonly parseTranscriptLine = parseClaudeTranscriptLine;

  // Claude's TUI takes a long burst of input as a paste and keeps its
  // newline in the composer, so a line is pasted and then submitted, with a
  // leading slash command's name typed so the command still runs.
  readonly planLineInput = planClaudeLineInput;

  readonly loadName: (
    source: string,
    namedBy: 'user' | 'auto' | 'agent',
  ) => Promise<NameUpdate | null> = loadClaudeName;

  readonly canResume: (session: ResumeCheck) => boolean = canResumeFromTranscript;

  readonly profile: AgentProfile;

  readonly takesMessages = true;

  private readonly entry: AgentEntry;

  private readonly authProfiles: Config['authProfiles'];

  private readonly options: ClaudeAdapterOptions;

  private readonly files: ClaudeLaunchFiles;

  constructor(
    entry: AgentEntry,
    config: Pick<Config, 'authProfiles'>,
    host: Pick<HostServices, 'atcArgv'>,
    options: ClaudeAdapterOptions = {},
  ) {
    const headlessRun = options.headlessRun ?? null;

    this.options = options;
    this.entry = entry;
    this.authProfiles = config.authProfiles;
    this.id = entry.id;

    this.files = new ClaudeLaunchFiles(this.buildSettingsProfile({}), host.atcArgv, options);

    this.profile = {
      label: entry.label,
      kind: 'claude',
      bin: entry.bin,
      models: null,
      spawnOptions: buildClaudeSpawnOptions(entry.args),
    };

    this.headlessRunner =
      headlessRun === null
        ? null
        : makeClaudeHeadlessRunner(headlessRun, {
            claudeBin: entry.bin,
            permissionMode: resolveClaudePermissionMode(entry.args, entry.settings),
            pluginDir: () => this.files.writeBridge(),
            settings: () => this.files.writeSettings(),
          });
  }

  // A session's scratch folder lies under its own folder in atc's state
  // folder, and is its temporary folder too.
  planSpawn(opts: SpawnOptions, session?: SessionID): SpawnPlan {
    const scratch =
      session === undefined ? null : createLocalScratchDir(session, this.options.stateDir);

    return {
      bin: this.entry.bin,
      args: buildClaudeArgs(this.entry.args, opts, {
        leadArgs: this.buildModeArgs(opts),
        scratch,
        settings: this.files.writeSettings(),
        pluginDir: this.files.writeBridge(),
      }),
      ...(scratch === null ? {} : { env: { TMPDIR: scratch } }),
    };
  }

  // With `auth` configured, Claude signs in with the subscription
  // token impd's broker holds on a target that reaches the broker, and
  // with the sign-in of the host it runs on anywhere else. The entry's own
  // placeholders stand in for the credentials of its other profiles, and
  // the subscription token's placeholder is always atc's.
  findAuthSelection(): AuthSelection | null {
    const auth = this.entry.auth;

    if (auth === undefined) {
      return null;
    }

    return {
      gateway: {
        id: this.id,
        baseURL: ANTHROPIC_API_URL,
        auth: {
          profiles: auth.profiles,
          placeholderEnv: {
            ...auth.placeholderEnv,
            [CLAUDE_CREDENTIAL_VARIABLES.oauthToken]: BROKER_PLACEHOLDER,
          },
        },
      },
      profiles: this.authProfiles,
      brokerRequired: false,
    };
  }

  // A remote session reports through the atc inside its host, so without
  // one it has no instrumentation and cannot run there. Its settings and
  // its copy of the mod travel with it, and it has no statusline. Its
  // scratch folder lies in its guest folder, which a shell creates before
  // it runs the CLI. A session that signs in through impd's broker runs
  // with a config folder of its own and the placeholder in place of the
  // token.
  planGuestSpawn(opts: SpawnOptions, guest: GuestPaths): GuestSpawnPlan | null {
    if (guest.atc === null) {
      return null;
    }

    const argv = [guest.atc];

    if (guest.auth !== undefined) {
      return this.planSubscriptionGuestSpawn(opts, guest.dir, guest.auth, argv);
    }

    const scratch = `${guest.dir}/${SESSION_SCRATCH_FOLDER}`;

    const launch = buildScratchLaunch(scratch, [
      this.entry.bin,
      ...buildClaudeArgs(this.entry.args, opts, {
        leadArgs: this.buildModeArgs(opts),
        scratch,
        settings: `${guest.dir}/settings.json`,
        pluginDir: `${guest.dir}/atc-bridge`,
      }),
    ]);

    const settings = buildHookSettings(this.buildSettingsProfile({}), 0, argv);

    return {
      ...launch,
      files: {
        'settings.json': JSON.stringify(settings, null, 2),
        ...buildGuestBridgeFiles(argv),
      },
    };
  }

  // Seeds the config folder of a session that signs in through impd's
  // broker with trust for the clone; any other remote session reads the
  // config of the host's image, which atc never writes.
  planGuestWorkspaceTrust(root: string): Readonly<Record<string, string>> | null {
    if (this.entry.auth === undefined) {
      return null;
    }

    return buildClaudeConfigSeed(root);
  }

  // The repository's own settings files outrank what the session's user
  // settings hold, so a launch behind impd's broker reads them first.
  planProjectSettingsCheck(): ProjectSettingsCheck {
    return buildClaudeProjectSettingsCheck(this.id);
  }

  // A session on the daemon's machine reads the user's own Claude config,
  // so trust for the clone is that config's entry for the clone alone.
  updateLocalWorkspaceTrust(root: string): Promise<() => Promise<void>> {
    return updateClaudeProjectTrust(resolveClaudeGlobalConfigPath(this.options.homeDir), root);
  }

  // Claude keeps no state across a session's hook lines.
  planHookEvents(e: HookEvent): HookPlan {
    return { events: [buildClaudeHookEvent(e)] };
  }

  // Shell command that re-opens this session outside atc (or anywhere). A
  // permission mode the configured arguments set travels as an explicit
  // flag, so it overrides the mode the CLI would restore. The generated
  // settings file travels only for an entry that sets its own settings or
  // environment, since the file sits on the daemon's machine and an entry
  // without either needs nothing from it.
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    const configured = findClaudePermissionMode(this.entry.args, this.entry.settings);
    const mode = configured === null ? '' : ` --permission-mode ${toShellArg(configured)}`;
    const resume = agentSessionID === undefined ? '' : ` ${agentSessionID}`;

    const settings =
      this.entry.settings === undefined && Object.keys(this.entry.env).length === 0
        ? ''
        : ` --settings ${toShellArg(this.files.writeSettings())}`;

    return `cd ${toShellArg(cwd)} && ${formatShellWord(this.entry.bin)}${mode}${settings} --resume${resume}`;
  }

  // A resumed session restores the permission mode the configured
  // arguments or settings set.
  private buildModeArgs(opts: SpawnOptions): string[] {
    return opts.resume === false ? [] : buildRestoreModeArgs(this.entry.args, this.entry.settings);
  }

  // A settings file of the session's own per binding revision carries the
  // placeholder, and so does the CLI's environment. The configured
  // arguments go without a permission mode, so the mode the session's own
  // user settings set applies. Those user settings, with the rest of the
  // config bundle, come from the host's own Claude config folder as it is
  // at this launch, staged under a key of this launch's own. A credential,
  // endpoint, or provider variable in the configured settings, or in the
  // host's environment, would keep the CLI from sending the placeholder, so
  // either refuses the start. The entry's MCP servers reach the CLI through
  // an MCP config file of the binding revision, each with the placeholder
  // in its header. Their flag and the scratch folder's sit ahead of the
  // settings flag, so neither variadic flag takes the prompt as one of its
  // values. When the profiles send a ChatGPT sign-in as well, the revision
  // holds a Codex home, so the Codex CLI the session runs as a tool signs
  // in through the broker too, with every variable that would sign it in
  // another way unset.
  private planSubscriptionGuestSpawn(
    opts: SpawnOptions,
    dir: string,
    auth: NonNullable<GuestPaths['auth']>,
    argv: readonly string[],
  ): GuestSpawnPlan {
    const refusal = this.findCredentialOverride();

    if (refusal !== null) {
      throw refusal;
    }

    const revisionFolder = buildAuthRevisionFolder(auth.revision);
    const settingsPath = `${revisionFolder}/settings.json`;
    const mcpServers = this.entry.mcpServers ?? [];
    const mcpPath = `${revisionFolder}/mcp.json`;
    const mcpArgs = mcpServers.length === 0 ? [] : ['--mcp-config', `${dir}/${mcpPath}`];
    const bundleKey = randomUUID();

    const codexHome = planCodexHome(
      this.authProfiles,
      this.entry.auth?.profiles ?? [],
      dir,
      revisionFolder,
      auth.oauth ?? {},
    );

    const launch = buildClaudeGuestLaunch(
      dir,
      [
        this.entry.bin,
        ...buildClaudeArgs(buildArgsWithoutFlags(this.entry.args, ['--permission-mode']), opts, {
          leadArgs: mcpArgs,
          scratch: `${dir}/${SESSION_SCRATCH_FOLDER}`,
          settings: `${dir}/${settingsPath}`,
          pluginDir: `${dir}/atc-bridge`,
        }),
      ],
      [...OUTRANKING_VARIABLES],
      bundleKey,
      codexHome.unsetEnv,
    );

    const bundle = {
      ...loadClaudeConfigBundle(
        resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude', this.options.homeDir),
        launch.env.CLAUDE_CONFIG_DIR,
        this.options.homeDir,
      ),
      '.credentials.json': buildClaudeCredentialsFile(),
    };

    // atc's statusline renders the one the bundle's user settings set
    // first, so it mirrors that one's padding.
    const userSettings = bundle['settings.json'];

    const padding =
      typeof userSettings === 'string' ? (parseClaudeStatusLine(userSettings).padding ?? 0) : 0;

    const settings = buildHookSettings(
      this.buildSettingsProfile({
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
      files: {
        [settingsPath]: JSON.stringify(settings, null, 2),
        ...(mcpServers.length === 0
          ? {}
          : { [mcpPath]: JSON.stringify(buildClaudeMCPConfig(mcpServers), null, 2) }),
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
  }

  // The refusal for an entry whose environment, settings environment, or
  // inline `--settings` argument sets a variable that overrides the
  // subscription sign-in or routes the CLI around impd's broker, or null
  // when it sets none.
  private findCredentialOverride(): DaemonError | null {
    const settingsEnv = this.entry.settings?.['env'];

    const sources: readonly (readonly [string, readonly string[]])[] = [
      ['env', Object.keys(this.entry.env)],
      ['settings.env', isRecord(settingsEnv) ? Object.keys(settingsEnv) : []],
      ['args in --settings', findInlineSettingsKeys(this.entry.args)],
    ];

    for (const [source, keys] of sources) {
      const variable = keys.find((key) => isSubscriptionOverrideVariable(key));

      if (variable !== undefined) {
        return new DaemonError(
          'auth_target_unsupported',
          `claude signs in through impd's broker on this target, but agents.${this.id}.${source === 'args in --settings' ? 'args set' : `${source} sets`} ${variable}${source === 'args in --settings' ? ' in --settings' : ''}, which would override or route around that sign-in`,
          { agent: this.id, problem: 'guest_env_conflict', variable },
        );
      }
    }

    return null;
  }

  // What the generated settings file holds for this entry: its hooks and
  // statusline, its settings, and its environment, with `extraEnv` on top.
  // The entry's environment outranks the settings' own env block.
  private buildSettingsProfile(extraEnv: Readonly<Record<string, string>>): HookSettingsProfile {
    const settingsEnv = this.entry.settings?.['env'];

    const env = {
      ...(isRecord(settingsEnv) ? toStringEntries(settingsEnv) : {}),
      ...this.entry.env,
      ...extraEnv,
    };

    return {
      id: this.id,
      env,
      ...(this.entry.settings === undefined ? {} : { settings: this.entry.settings }),
    };
  }
}

// The endpoint Claude Code sends a subscription token to.
const ANTHROPIC_API_URL = 'https://api.anthropic.com';

// An inline `--settings` argument's env block; any other shape holds no
// variables.
const INLINE_SETTINGS_SCHEMA = z.object({ env: z.record(z.string(), z.unknown()) });

// The variables an inline `--settings` argument sets in its env block.
function findInlineSettingsKeys(args: readonly string[]): string[] {
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

// The string values of an object, which is all a session's environment holds.
function toStringEntries(value: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
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

// A binary name or path that needs no quoting stays bare, so the default
// entry resumes with plain `claude`; anything else is quoted as one word.
function formatShellWord(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : toShellArg(value);
}
