import type { AgentEntry, Config } from '@atc/config';
import { resolveAuthProfiles } from '@atc/config';
import { resolveAgentHome } from '@atc/config/host';
import type { AgentID, AgentSessionID } from '@atc/core';
import { toShellArg } from '@atc/core';
import type {
  AgentAdapter,
  AgentProfile,
  AuthSelection,
  GuestOAuthState,
  GuestPaths,
  GuestSpawnPlan,
  HookPlan,
  MessageBridge,
  MessageBridgeRequest,
  NameUpdate,
  SpawnOptionSpecs,
  SpawnOptions,
  SpawnPlan,
} from '@atc/plugin-api';
import {
  buildArgsWithoutFlags,
  buildAuthRevisionFolder,
  buildCodexAuthFile,
  buildCodexConfig,
  canResumeFromTranscript,
  findCodexSignIn,
  findFlagValue,
} from '@atc/plugin-api';
import type { HookEvent } from '@atc/protocol/session';
import { DaemonError } from '@atc/protocol/wire';
import { startCodexAppServerBridge } from './app-server/start-codex-app-server-bridge';
import { buildCodexGuestLaunch } from './build-codex-guest-launch';
import { buildCodexHookFile } from './build-codex-hook-file';
import { buildCodexTrustSeed } from './build-codex-trust-seed';
import { loadCodexName } from './load-codex-name';
import { planCodexHookEvents } from './plan-codex-hook-events';
import { planCodexLineInput } from './plan-codex-line-input';

// The spellings of the Codex CLI's model flag.
const CODEX_MODEL_FLAGS = ['-m', '--model'];

// The Codex CLI flag that runs a terminal without the shared background
// server, and the flag that connects it to a remote server instead.
const NO_DAEMON_FLAG = '--no-daemon';
const REMOTE_FLAG = '--remote';

/**
 * The Codex CLI adapter: spawn arguments, hook payload mapping, resume
 * semantics, and session_index.jsonl name-pulling. Hooks are a user-installed
 * entry in the Codex hook config (`atc codex-hooks` prints it) that the user
 * trusts once in the Codex TUI; atc never writes into the user's Codex config.
 * An entry with `auth` signs in on an imp through the ChatGPT sign-in impd's
 * broker holds, with a Codex home of the session's own that atc writes.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id: AgentID;

  // The hook files a user installs print the kind for every entry of it, so
  // the hook lines of every codex entry carry it.
  readonly hookAgent = 'codex';

  // Codex has no headless handoff.
  readonly headlessRunner = null;

  // Codex's hooks are authoritative; no screen heuristics needed.
  readonly screenDetector = null;

  readonly profile: AgentProfile;

  // Only a session on an App Server of its own takes messages, through the
  // bridge the daemon runs beside it.
  readonly takesMessages: boolean;

  // Present only for an entry with `appServer`.
  readonly startMessageBridge?: (request: MessageBridgeRequest) => Promise<MessageBridge>;

  // Codex's TUI keeps a newline that arrives inside a burst of input, so a
  // line is pasted and then submitted, a slash command as two pastes.
  readonly planLineInput = planCodexLineInput;

  // A session resumes while its rollout exists.
  readonly canResume = canResumeFromTranscript;

  // Present only for an entry with `auth`: any other entry runs on a
  // remote host as a local spawn plans it, under the sign-in of the host's
  // image, and needs no atc there.
  readonly planGuestSpawn?: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;

  private readonly entry: AgentEntry;

  private readonly authProfiles: Config['authProfiles'];

  // The Codex home whose session index holds session titles; unset, it follows
  // `CODEX_HOME` or the user's home at each read.
  private readonly codexHome: string | undefined;

  constructor(entry: AgentEntry, config?: Pick<Config, 'authProfiles'>, codexHome?: string) {
    this.entry = entry;
    this.authProfiles = config?.authProfiles ?? new Map();
    this.codexHome = codexHome;
    this.id = entry.id;
    this.takesMessages = entry.appServer === true;

    if (entry.appServer === true) {
      this.startMessageBridge = (request) => this.startAppServerBridge(request);
    }

    if (entry.auth !== undefined) {
      this.planGuestSpawn = (opts, guest) => this.planSignedInGuestSpawn(opts, guest);
    }

    this.profile = {
      label: entry.label,
      kind: 'codex',
      bin: entry.bin,
      models: null,
      spawnOptions: buildCodexSpawnOptions(entry.args),
    };
  }

  planSpawn(opts: SpawnOptions): SpawnPlan {
    return {
      bin: this.entry.bin,
      args: [
        // Codex's shared background server keeps the environment of the
        // terminal that started it and runs every thread's hooks and tools
        // there, so a terminal on it reports as that first session. Each
        // terminal therefore runs its own server. The configured arguments
        // already carry the flag, or connect to a remote server, which Codex
        // refuses to combine with it; either way Codex takes no second copy.
        ...(this.entry.args.some(isDaemonChoiceFlag) ? [] : [NO_DAEMON_FLAG]),

        // A model override replaces any model flag the configured arguments
        // carry, and travels as its own argument.
        ...(opts.model === undefined
          ? this.entry.args
          : [...buildArgsWithoutFlags(this.entry.args, CODEX_MODEL_FLAGS), '-m', opts.model]),

        // Bare resume opens Codex's own session picker; an id resumes that
        // session directly. Both accept a prompt afterwards.
        ...(opts.resume === true ? ['resume'] : []),
        ...(typeof opts.resume === 'string' ? ['resume', opts.resume] : []),
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  // The bridge owns the thread a terminal on its App Server joins, so a
  // resume through Codex's own session picker, which picks the thread in
  // the terminal, is refused rather than started as a new thread.
  private startAppServerBridge(request: MessageBridgeRequest): Promise<MessageBridge> {
    if (request.options.resume === true) {
      const refusal = new DaemonError(
        'unsupported',
        `agent '${this.id}' runs on a Codex App Server, which resumes a session by its id and has no session picker`,
        { agent: this.id },
      );

      return Promise.reject(refusal);
    }

    return startCodexAppServerBridge(request, {
      bin: this.entry.bin,
      planTerminal: (remote, thread) => this.planRemoteTerminal(request.options, remote, thread),
    });
  }

  // A terminal on the session's own App Server resumes the thread the
  // bridge holds there, in place of the server of its own that a plain
  // launch runs. A server choice the configured arguments carry gives way
  // to it.
  private planRemoteTerminal(opts: SpawnOptions, remote: string, thread: string): SpawnPlan {
    const replaced = opts.model === undefined ? [REMOTE_FLAG] : [REMOTE_FLAG, ...CODEX_MODEL_FLAGS];

    const args = buildArgsWithoutFlags(
      this.entry.args.filter((arg) => arg !== NO_DAEMON_FLAG),
      replaced,
    );

    return {
      bin: this.entry.bin,
      args: [
        ...args,
        ...(opts.model === undefined ? [] : ['-m', opts.model]),
        'resume',
        thread,
        REMOTE_FLAG,
        remote,
        ...(opts.prompt === '' ? [] : [opts.prompt]),
      ],
    };
  }

  // With `auth` configured, Codex signs in with the ChatGPT sign-in impd's
  // broker holds on a target that reaches the broker, and with the sign-in
  // of the host it runs on anywhere else.
  findAuthSelection(): AuthSelection | null {
    const auth = this.entry.auth;

    if (auth === undefined) {
      return null;
    }

    return {
      gateway: { id: this.id, baseURL: CHATGPT_CODEX_URL, auth },
      profiles: this.authProfiles,
      brokerRequired: false,
    };
  }

  // A remote session without the broker runs as a local spawn plans it,
  // under the sign-in of the host's image. One behind the broker reports
  // through the atc inside its host, so without one it cannot run there,
  // and it runs with a Codex home of its own: a sign-in file that holds
  // no credential, a config, and the hook file, staged per binding
  // revision. Its hooks are trusted at launch, since atc wrote them.
  private planSignedInGuestSpawn(opts: SpawnOptions, guest: GuestPaths): GuestSpawnPlan | null {
    if (guest.auth === undefined) {
      return { ...this.planSpawn(opts), files: {} };
    }

    if (guest.atc === null) {
      return null;
    }

    const authDir = buildAuthRevisionFolder(guest.auth.revision);
    const signIn = this.requireSignIn(guest.auth.oauth ?? {});
    const plan = this.planSpawn(opts);

    // the flag outranks a trusted clone's own config, which could move the
    // sign-in out of the file atc writes
    const launch = buildCodexGuestLaunch(guest.dir, authDir, [
      plan.bin,
      HOOK_TRUST_FLAG,
      '-c',
      FILE_CREDENTIALS_OVERRIDE,
      ...plan.args,
    ]);

    return {
      bin: launch.bin,
      args: launch.args,
      files: {
        [`${authDir}/auth.json`]: buildCodexAuthFile(signIn.idClaims, signIn.accountID),
        [`${authDir}/config.toml`]: buildCodexConfig(),
        [`${authDir}/hooks.json`]: buildCodexHookFile([guest.atc]),
      },
      env: { ...guest.auth.profileEnv, ...guest.auth.env, ...launch.env },
    };
  }

  // Seeds the config of a session that signs in through impd's broker with
  // trust for the clone; any other remote session reads the config of the
  // host's image, which atc never writes.
  planGuestWorkspaceTrust(root: string): Readonly<Record<string, string>> | null {
    if (this.entry.auth === undefined) {
      return null;
    }

    return buildCodexTrustSeed(root);
  }

  // The ID token claims and account id of the oauth secret this entry's
  // profiles send to chatgpt.com, or the refusal for a sign-in that is not
  // ready or that holds no account id.
  private requireSignIn(states: Readonly<Record<string, GuestOAuthState>>): {
    readonly idClaims: Readonly<Record<string, unknown>>;
    readonly accountID: string;
  } {
    const secret = this.findChatGPTSecret();
    const state = secret === null ? undefined : states[secret];
    const name = secret ?? 'the oauth secret';
    const renew = `sign Codex in again and run imp secret add ${name} --kind oauth ... --replace with the new refresh token`;

    if (state?.status !== 'ready') {
      throw new DaemonError(
        'auth_signin_needed',
        `agent '${this.id}' signs in through ${name}, whose sign-in in impd is ${state?.status ?? 'not listed'}; ${renew}`,
        { agent: this.id, secret, status: state?.status ?? null },
      );
    }

    const signIn = findCodexSignIn(state);

    if (signIn === null) {
      throw new DaemonError(
        'auth_signin_needed',
        `agent '${this.id}' signs in through ${name}, whose ID token in impd holds no ChatGPT account id; ${renew}`,
        { agent: this.id, secret, status: state.status },
      );
    }

    return signIn;
  }

  // The secret this entry's profiles send to chatgpt.com, or null when
  // they no longer resolve to one.
  private findChatGPTSecret(): string | null {
    const auth = this.entry.auth;

    if (auth === undefined) {
      return null;
    }

    const resolution = resolveAuthProfiles(this.authProfiles, auth.profiles);

    if ('problem' in resolution) {
      return null;
    }

    const found = resolution.resolved.secrets.find((secret) =>
      secret.rules.some((rule) => rule.host === CHATGPT_HOST),
    );

    return found?.secret ?? null;
  }

  planHookEvents(e: HookEvent, prev: unknown): HookPlan {
    return planCodexHookEvents(e, prev);
  }

  // Codex records session titles in the session index of its home.
  loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    return loadCodexName(
      this.codexHome ?? resolveAgentHome('CODEX_HOME', '.codex'),
      source,
      namedBy,
    );
  }

  // Shell command that re-opens this session outside atc (or anywhere).
  buildResumeCommand(cwd: string, agentSessionID: AgentSessionID | undefined): string | null {
    const resume = agentSessionID === undefined ? 'codex resume' : `codex resume ${agentSessionID}`;

    return `cd ${toShellArg(cwd)} && ${resume}`;
  }
}

// Where Codex sends its ChatGPT sign-in: the endpoint its model requests go
// to, and the host impd's broker sets the access token on.
const CHATGPT_CODEX_URL = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_HOST = 'chatgpt.com';

// Codex's documented flag that runs hooks without the trust a person
// gives them in the TUI, meant for automation that vets its hook sources.
const HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';

// A config override on the command line, which outranks every config file.
const FILE_CREDENTIALS_OVERRIDE = 'cli_auth_credentials_store="file"';

// What a Codex spawn can override. Codex documents its reasoning effort as
// whatever the selected model advertises, with no closed list of levels, so
// atc takes no effort for it.
function buildCodexSpawnOptions(codexArgs: readonly string[]): SpawnOptionSpecs {
  return {
    model: {
      supported: true,
      values: null,
      examples: [],
      default: findFlagValue(codexArgs, CODEX_MODEL_FLAGS),
      backendEffect: 'applied',
      note: 'A model name, passed as -m.',
    },
    effort: {
      supported: false,
      values: null,
      examples: [],
      default: null,
      backendEffect: null,
      note: 'Codex documents its reasoning effort levels as depending on the model, with no closed list, so atc does not pass one.',
    },
  };
}

// Whether a configured argument already decides which server a terminal
// uses: the flag that runs it without the shared one, or the remote server
// flag in either of its spellings.
function isDaemonChoiceFlag(arg: string): boolean {
  return arg === NO_DAEMON_FLAG || arg === REMOTE_FLAG || arg.startsWith(`${REMOTE_FLAG}=`);
}
