import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AdapterEvent } from '../protocol/adapter-event';
import { DaemonError } from '../protocol/daemon-error';
import type { HookEvent } from '../protocol/hook-event';
import type { AgentSessionID } from '../shared/agent-session-id';
import { buildOptionalString } from '../shared/build-optional-string';
import type { Config } from '../shared/config';
import { isBrokerVariable } from '../shared/is-broker-variable';
import { isRecord } from '../shared/report';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toShellArg } from '../shared/to-shell-arg';
import { truncateDetail } from '../shared/truncate-detail';
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
import { buildArgsWithoutFlags } from './build-args-without-flags';
import { buildATCBridgeFiles } from './build-atc-bridge-files';
import { buildClaudeConfigSeed } from './build-claude-config-seed';
import { buildClaudeGuestLaunch } from './build-claude-guest-launch';
import { buildClaudeOverrideArgs } from './build-claude-override-args';
import { buildHookSettings } from './build-hook-settings';
import { CLAUDE_CONFIG_BUNDLE_FOLDER } from './claude-config-bundle-folder';
import { CLAUDE_EFFORT_LEVELS } from './claude-effort-levels';
import { findClaudePermissionMode } from './find-claude-permission-mode';
import { findFlagValue } from './find-flag-value';
import { loadClaudeConfigBundle } from './load-claude-config-bundle';
import { makeClaudeHeadlessRunner } from './make-claude-headless-runner';
import type { ClaudeHeadlessRun } from './make-claude-headless-runner';
import { parseClaudeTranscriptLine } from './parse-claude-transcript-line';
import { planPastedLineInput } from './plan-pasted-line-input';
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

  // Claude's TUI takes a long burst of input as a paste and keeps its
  // newline in the composer, so a line is pasted and then submitted.
  readonly planLineInput = planPastedLineInput;

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
      args: this.buildArgs(this.config.claudeArgs, opts, this.settingsFile, this.writeBridge()),
    };
  }

  // With `claudeAuth` configured, Claude signs in with the subscription
  // token impd's broker holds on a target that reaches the broker, and
  // with the sign-in of the host it runs on anywhere else.
  findAuthSelection(): AuthSelection | null {
    const auth = this.config.claudeAuth;

    if (auth === null) {
      return null;
    }

    return {
      gateway: {
        id: this.id,
        baseURL: ANTHROPIC_API_URL,
        auth: { profiles: auth.profiles, placeholderEnv: { [OAUTH_VARIABLE]: PLACEHOLDER } },
      },
      profiles: this.config.authProfiles,
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

    const bridge = Object.entries(buildATCBridgeFiles(argv)).map(
      ([path, content]): [string, string] => [`atc-bridge/${path}`, content],
    );

    if (guest.auth !== undefined) {
      return this.planSubscriptionGuestSpawn(opts, guest.dir, guest.auth, argv, bridge);
    }

    return {
      bin: this.config.claudeBin,
      args: this.buildArgs(
        this.config.claudeArgs,
        opts,
        `${guest.dir}/settings.json`,
        `${guest.dir}/atc-bridge`,
      ),
      files: {
        'settings.json': JSON.stringify(buildHookSettings({ id: this.id }, 0, argv), null, 2),
        ...Object.fromEntries(bridge),
      },
    };
  }

  // Seeds the config folder of a session that signs in through impd's
  // broker with trust for the clone; any other remote session reads the
  // config of the host's image, which atc never writes.
  planGuestWorkspaceTrust(root: string): Readonly<Record<string, string>> | null {
    if (this.config.claudeAuth === null) {
      return null;
    }

    return buildClaudeConfigSeed(root);
  }

  // A settings file of the session's own per binding revision carries the
  // placeholder, and so does the CLI's environment. The configured
  // arguments go without a permission mode, so the mode the session's own
  // user settings set applies. Those user settings, with the rest of the
  // config bundle, come from the host's own Claude config folder as it is
  // at this launch. A credential, endpoint, or provider variable in the
  // configured settings, or in the host's environment, would keep the CLI
  // from sending the placeholder, so either refuses the start.
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

    const launch = buildClaudeGuestLaunch(
      dir,
      [
        this.config.claudeBin,
        ...this.buildArgs(
          buildArgsWithoutFlags(this.config.claudeArgs, ['--permission-mode']),
          opts,
          `${dir}/${settingsPath}`,
          `${dir}/atc-bridge`,
        ),
      ],
      [...OUTRANKING_VARIABLES],
    );

    const bundle = loadClaudeConfigBundle(
      resolveAgentHome('CLAUDE_CONFIG_DIR', '.claude'),
      launch.env.CLAUDE_CONFIG_DIR,
    );

    const userSettings = bundle['settings.json'];
    const padding = typeof userSettings === 'string' ? findStatuslinePadding(userSettings) : 0;

    const settings = buildHookSettings(
      { id: this.id, env: { ...auth.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } },
      padding,
      argv,
    );

    return {
      bin: launch.bin,
      args: launch.args,
      files: {
        [settingsPath]: JSON.stringify(settings, null, 2),
        ...buildClaudeConfigSeed(null),
        ...Object.fromEntries(
          Object.entries(bundle).map(([path, content]) => [
            `${CLAUDE_CONFIG_BUNDLE_FOLDER}/${path}`,
            content,
          ]),
        ),
        ...Object.fromEntries(bridge),
      },
      env: { ...launch.env, ...auth.env },
    };
  }

  // The refusal for configured arguments whose inline `--settings` sets a
  // variable that overrides the subscription sign-in or routes the CLI
  // around impd's broker, or null when they set none.
  private findCredentialOverride(): DaemonError | null {
    const inline = findFlagValue(this.config.claudeArgs, ['--settings']);

    if (inline === null) {
      return null;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(inline);
    } catch {
      return null;
    }

    const env = isRecord(parsed) ? parsed['env'] : undefined;
    const keys = isRecord(env) ? Object.keys(env) : [];

    const variable = keys.find(
      (key) => OUTRANKING_VARIABLES.has(key) || key === OAUTH_VARIABLE || isBrokerVariable(key),
    );

    if (variable === undefined) {
      return null;
    }

    return new DaemonError(
      'auth_target_unsupported',
      `claude signs in through impd's broker on this target, but claudeArgs set ${variable} in --settings, which would override or route around that sign-in`,
      { agent: this.id, problem: 'guest_env_conflict', variable },
    );
  }

  private buildArgs(
    configured: readonly string[],
    opts: SpawnOptions,
    settings: string,
    pluginDir: string,
  ): string[] {
    return [
      ...buildClaudeOverrideArgs(configured, opts),
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

  // A session on the daemon's machine reads the user's own Claude config,
  // so trust for the clone is that config's entry for the clone alone.
  updateLocalWorkspaceTrust(root: string): Promise<() => Promise<void>> {
    return updateClaudeProjectTrust(resolveClaudeGlobalConfigPath(), root);
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

// The endpoint Claude Code sends a subscription token to, the variable it
// reads that token from, and the value impd's broker replaces with the
// token on the host's side.
const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const OAUTH_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';
const PLACEHOLDER = 'imp-broker-placeholder';

// The variables that keep Claude Code from sending the subscription token
// to the Anthropic API: a credential it takes ahead of that token, another
// endpoint, or a cloud provider it signs in to instead.
const OUTRANKING_VARIABLES: ReadonlySet<string> = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_GATEWAY',
]);

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
