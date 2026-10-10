import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AdapterEvent } from '../protocol/adapter-event';
import { DaemonError } from '../protocol/daemon-error';
import type { HookEvent } from '../protocol/hook-event';
import type { AgentID } from '../shared/agent-id';
import type { AgentSessionID } from '../shared/agent-session-id';
import { buildOptionalString } from '../shared/build-optional-string';
import type { AgentEntry } from '../shared/collect-agents';
import type { Config } from '../shared/config';
import { isSubscriptionOverrideVariable } from '../shared/is-subscription-override-variable';
import { OUTRANKING_VARIABLES } from '../shared/outranking-variables';
import { isRecord } from '../shared/report';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toShellArg } from '../shared/to-shell-arg';
import { truncateDetail } from '../shared/truncate-detail';
import type {
  AgentAdapter,
  AgentProfile,
  AuthSelection,
  ClaudeHostPaths,
  GuestPaths,
  GuestSpawnPlan,
  HeadlessRunner,
  NameUpdate,
  ProjectSettingsCheck,
  ResumeCheck,
  SpawnOptionSpecs,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import { buildArgsWithoutFlags } from './build-args-without-flags';
import { buildATCBridgeFiles } from './build-atc-bridge-files';
import { buildClaudeConfigSeed } from './build-claude-config-seed';
import { buildClaudeGuestLaunch } from './build-claude-guest-launch';
import { buildClaudeMCPConfig } from './build-claude-mcp-config';
import { buildClaudeOverrideArgs } from './build-claude-override-args';
import { buildClaudeProjectSettingsCheck } from './build-claude-project-settings-check';
import { buildHookSettings } from './build-hook-settings';
import type { HookSettingsProfile } from './build-hook-settings';
import { buildRestoreModeArgs } from './build-restore-mode-args';
import { CLAUDE_CONFIG_BUNDLE_FOLDER } from './claude-config-bundle-folder';
import { CLAUDE_EFFORT_LEVELS } from './claude-effort-levels';
import { findClaudePermissionMode } from './find-claude-permission-mode';
import { findFlagValue } from './find-flag-value';
import { loadClaudeConfigBundle } from './load-claude-config-bundle';
import { makeClaudeHeadlessRunner } from './make-claude-headless-runner';
import type { ClaudeHeadlessRun } from './make-claude-headless-runner';
import { parseClaudeTranscriptLine } from './parse-claude-transcript-line';
import { planClaudeLineInput } from './plan-claude-line-input';
import { resolveAgentHome } from './resolve-agent-home';
import { resolveClaudeGlobalConfigPath } from './resolve-claude-global-config-path';
import { resolveClaudePermissionMode } from './resolve-claude-permission-mode';
import { updateClaudeProjectTrust } from './update-claude-project-trust';
import { writeATCBridge } from './write-atc-bridge';
import { writeHookSettings } from './write-hook-settings';

// Claude's hook payload keys, snake_case. An absent or wrong-typed field
// parses to undefined rather than failing the payload, so a broken reporter
// never breaks the session it reports on.
const CLAUDE_HOOK_PAYLOAD_SCHEMA = z.object({
  session_id: buildOptionalString(),
  transcript_path: buildOptionalString(),
  message: buildOptionalString(),
  notification_type: buildOptionalString(),
  last_assistant_message: buildOptionalString(),
  prompt: buildOptionalString(),
});

type ClaudeHookPayload = z.infer<typeof CLAUDE_HOOK_PAYLOAD_SCHEMA>;

/**
 * The Claude Code adapter: spawn arguments, `--settings` instrumentation,
 * resume semantics, transcript name-pulling, and statusline chaining.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id: AgentID;

  // The agent value the hook lines of a Claude session carry: the settings
  // file atc writes for this id names it on each hook command.
  readonly hookAgent: AgentID;

  readonly headlessRunner: HeadlessRunner | null;

  // Claude's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  readonly parseTranscriptLine = parseClaudeTranscriptLine;

  // Claude's TUI takes a long burst of input as a paste and keeps its
  // newline in the composer, so a line is pasted and then submitted, with a
  // leading slash command's name typed so the command still runs.
  readonly planLineInput = planClaudeLineInput;

  readonly profile: AgentProfile;

  readonly takesMessages = true;

  private readonly entry: AgentEntry;

  private readonly authProfiles: Config['authProfiles'];

  // Written on first spawn so constructing the adapter touches no state.
  private settingsFile: string | undefined;

  // Written on first spawn so constructing the adapter touches no state.
  private bridgeDir: string | undefined;

  private readonly bridgeTarget: string | undefined;

  private readonly hostPaths: ClaudeHostPaths;

  constructor(
    entry: AgentEntry,
    config: Pick<Config, 'authProfiles'>,
    headlessRun: ClaudeHeadlessRun | null = null,
    bridgeTarget?: string,
    hostPaths: ClaudeHostPaths = {},
  ) {
    this.bridgeTarget = bridgeTarget;
    this.hostPaths = hostPaths;
    this.entry = entry;
    this.authProfiles = config.authProfiles;
    this.id = entry.id;
    this.hookAgent = entry.id;

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
            pluginDir: () => this.writeBridge(),
            settings: () => this.writeSettings(),
          });
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    const modeArgs =
      opts.resume === false ? [] : buildRestoreModeArgs(this.entry.args, this.entry.settings);

    return {
      bin: this.entry.bin,
      args: this.buildArgs(
        this.entry.args,
        opts,
        modeArgs,
        this.writeSettings(),
        this.writeBridge(),
      ),
    };
  }

  // With `auth` configured, Claude signs in with the subscription
  // token impd's broker holds on a target that reaches the broker, and
  // with the sign-in of the host it runs on anywhere else.
  findAuthSelection(): AuthSelection | null {
    const auth = this.entry.auth;

    if (auth === undefined) {
      return null;
    }

    return {
      gateway: {
        id: this.id,
        baseURL: ANTHROPIC_API_URL,
        auth: { profiles: auth.profiles, placeholderEnv: { [OAUTH_VARIABLE]: PLACEHOLDER } },
      },
      profiles: this.authProfiles,
      brokerRequired: false,
    };
  }

  // A remote session reports through the atc inside its host, so without
  // one it has no instrumentation and cannot run there. Its settings and
  // its copy of the mod travel with it, and it has no statusline. A
  // session that signs in through impd's broker runs with a config folder
  // of its own and the placeholder in place of the token.
  planGuestSpawn(opts: SpawnOptions, guest: GuestPaths): GuestSpawnPlan | null {
    if (guest.atc === null) {
      return null;
    }

    const argv = [guest.atc];

    const modeArgs =
      opts.resume === false ? [] : buildRestoreModeArgs(this.entry.args, this.entry.settings);

    const bridge = Object.entries(buildATCBridgeFiles(argv)).map(
      ([path, content]): [string, string] => [`atc-bridge/${path}`, content],
    );

    if (guest.auth !== undefined) {
      return this.planSubscriptionGuestSpawn(opts, guest.dir, guest.auth, argv, bridge);
    }

    return {
      bin: this.entry.bin,
      args: this.buildArgs(
        this.entry.args,
        opts,
        modeArgs,
        `${guest.dir}/settings.json`,
        `${guest.dir}/atc-bridge`,
      ),
      files: {
        'settings.json': JSON.stringify(
          buildHookSettings(this.buildSettingsProfile({}), 0, argv),
          null,
          2,
        ),
        ...Object.fromEntries(bridge),
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

  // A settings file of the session's own per binding revision carries the
  // placeholder, and so does the CLI's environment. The configured
  // arguments go without a permission mode, so the mode the session's own
  // user settings set applies. Those user settings, with the rest of the
  // config bundle, come from the host's own Claude config folder as it is
  // at this launch, staged under a key of this launch's own. A credential, endpoint, or provider variable in the
  // configured settings, or in the host's environment, would keep the CLI
  // from sending the placeholder, so either refuses the start. The entry's
  // MCP servers reach the CLI through an MCP config file of the binding
  // revision, each with the placeholder in its header. Their flag sits
  // ahead of the settings flag, so the variadic flag never takes the
  // prompt as one of its values.
  private planSubscriptionGuestSpawn(
    opts: SpawnOptions,
    dir: string,
    auth: NonNullable<GuestPaths['auth']>,
    argv: readonly string[],
    bridge: readonly (readonly [string, string])[],
  ): GuestSpawnPlan {
    const refusal = this.findCredentialOverride();

    if (refusal !== null) {
      throw refusal;
    }

    const settingsPath = `auth-r${auth.revision}/settings.json`;
    const mcpServers = this.entry.mcpServers ?? [];
    const mcpPath = `auth-r${auth.revision}/mcp.json`;
    const mcpArgs = mcpServers.length === 0 ? [] : ['--mcp-config', `${dir}/${mcpPath}`];
    const bundleKey = randomUUID();

    const launch = buildClaudeGuestLaunch(
      dir,
      [
        this.entry.bin,
        ...this.buildArgs(
          buildArgsWithoutFlags(this.entry.args, ['--permission-mode']),
          opts,
          mcpArgs,
          `${dir}/${settingsPath}`,
          `${dir}/atc-bridge`,
        ),
      ],
      [...OUTRANKING_VARIABLES],
      bundleKey,
    );

    const bundle = loadClaudeConfigBundle(
      resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude', this.hostPaths.homeDir),
      launch.env.CLAUDE_CONFIG_DIR,
      this.hostPaths.homeDir,
    );

    const userSettings = bundle['settings.json'];
    const padding = typeof userSettings === 'string' ? findStatuslinePadding(userSettings) : 0;

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
        ...Object.fromEntries(bridge),
      },
      env: { ...launch.env, ...auth.profileEnv, ...auth.env },
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
      ['args in --settings', this.findInlineSettingsKeys()],
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

  // The variables an inline `--settings` argument sets in its env block.
  private findInlineSettingsKeys(): string[] {
    const inline = findFlagValue(this.entry.args, ['--settings']);

    if (inline === null) {
      return [];
    }

    try {
      const parsed: unknown = JSON.parse(inline);
      const env = isRecord(parsed) ? parsed['env'] : undefined;

      return isRecord(env) ? Object.keys(env) : [];
    } catch {
      return [];
    }
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

  private buildArgs(
    configured: readonly string[],
    opts: SpawnOptions,
    leadArgs: readonly string[],
    settings: string,
    pluginDir: string,
  ): string[] {
    return [
      ...buildClaudeOverrideArgs(configured, opts),
      ...leadArgs,
      '--settings',
      settings,
      '--plugin-dir',
      pluginDir,
      ...(opts.resume === true ? ['--resume'] : []),
      ...(typeof opts.resume === 'string' ? ['--resume', opts.resume] : []),
      ...(opts.prompt === '' ? [] : [opts.prompt]),
    ];
  }

  private writeSettings(): string {
    this.settingsFile ??= writeHookSettings(
      this.buildSettingsProfile({}),
      this.hostPaths.stateDir,
      this.hostPaths.homeDir,
    );

    return this.settingsFile;
  }

  private writeBridge(): string {
    this.bridgeDir ??= writeATCBridge(this.bridgeTarget);

    return this.bridgeDir;
  }

  // A session on the daemon's machine reads the user's own Claude config,
  // so trust for the clone is that config's entry for the clone alone.
  updateLocalWorkspaceTrust(root: string): Promise<() => Promise<void>> {
    return updateClaudeProjectTrust(resolveClaudeGlobalConfigPath(this.hostPaths.homeDir), root);
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
          ...buildPermissionPending(payload.notification_type),
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
        : ` --settings ${toShellArg(this.writeSettings())}`;

    return `cd ${toShellArg(cwd)} && ${formatShellWord(this.entry.bin)}${mode}${settings} --resume${resume}`;
  }
}

// The endpoint Claude Code sends a subscription token to, the variable it
// reads that token from, and the value impd's broker replaces with the
// token on the host's side.
const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const OAUTH_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';
const PLACEHOLDER = 'imp-broker-placeholder';

// The string values of an object, which is all a session's environment holds.
function toStringEntries(value: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

// The padding of the statusline the bundle's user settings set, which atc's
// own statusline mirrors since it renders that one first, or none.
function findStatuslinePadding(settings: string): number {
  try {
    const parsed: unknown = JSON.parse(settings);
    const statusLine = isRecord(parsed) ? parsed['statusLine'] : undefined;
    const padding = isRecord(statusLine) ? statusLine['padding'] : undefined;

    return typeof padding === 'number' ? padding : 0;
  } catch {
    return 0;
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

// A permission prompt waits on a person; an idle notice shows that no prompt
// is open. Any other notice says neither, so it leaves the field out.
function buildPermissionPending(type: string | undefined): { permissionPending?: boolean } {
  if (type === 'permission_prompt') {
    return { permissionPending: true };
  }

  if (type === 'idle_prompt') {
    return { permissionPending: false };
  }

  return {};
}

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
