import type { AgentEntry, Config } from '@atc/config';
import { resolveAuthProfiles } from '@atc/config';
import { resolveAgentHome } from '@atc/config/host';
import type { AgentID } from '@atc/core';
import { toShellArg } from '@atc/core';
import type {
  AgentAdapter,
  AgentProfile,
  AuthSelection,
  GuestOAuthState,
  GuestPaths,
  GuestSpawnPlan,
  LineInputStep,
  MessageBridge,
  MessageBridgeRequest,
  SpawnOptionSpecs,
  SpawnOptions,
  SpawnPlan,
  TerminalInputModes,
} from '@atc/plugin-api';
import {
  buildArgsWithoutFlags,
  buildAuthRevisionFolder,
  buildCodexAuthFile,
  buildCodexConfig,
  findCodexSignIn,
  findFlagValue,
  probeTranscriptResumable,
} from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { AgentSessionID } from '@atcx/contract';
import { startCodexAppServerBridge } from './app-server/start-codex-app-server-bridge';
import { buildCodexGuestLaunch } from './build-codex-guest-launch';
import { buildCodexHookFile } from './build-codex-hook-file';
import { buildCodexTrustSeed } from './build-codex-trust-seed';
import { loadCodexName } from './load-codex-name';
import { planCodexHookEvents } from './plan-codex-hook-events';
import { planCodexLineInput } from './plan-codex-line-input';

export interface CodexAdapter extends AgentAdapter {
  // The hook files a user installs print the kind for every entry of it, so
  // the hook lines of every codex entry carry it.
  readonly hookAgent: AgentID;
  readonly profile: AgentProfile;

  // Present only for an entry with `appServer`.
  readonly startMessageBridge?: (request: MessageBridgeRequest) => Promise<MessageBridge>;

  // Codex's TUI keeps a newline that arrives inside a burst of input, so a
  // line is pasted and then submitted, a slash command as two pastes.
  readonly planLineInput: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  // Present only for an entry with `auth`: any other entry runs on a
  // remote host as a local spawn plans it, under the sign-in of the host's
  // image, and needs no atc there.
  readonly planGuestSpawn?: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;

  // With `auth` configured, Codex signs in with the ChatGPT sign-in the
  // target's broker holds on a target that reaches a broker, and with the
  // sign-in of the host it runs on anywhere else.
  readonly findAuthSelection: () => AuthSelection | null;

  // Seeds the config of a session that signs in through the target's broker with
  // trust for the clone; any other remote session reads the config of the
  // host's image, which atc never writes.
  readonly planGuestWorkspaceTrust: (root: string) => Readonly<Record<string, string>> | null;

  // Shell command that re-opens this session outside atc (or anywhere).
  readonly planResumeCommand: (
    cwd: string,
    agentSessionID: AgentSessionID | undefined,
  ) => string | null;
}

// The spellings of the Codex CLI's model flag.
const CODEX_MODEL_FLAGS = ['-m', '--model'];

// The Codex CLI flag that runs a terminal without the shared background
// server, and the flag that connects it to a remote server instead.
const NO_DAEMON_FLAG = '--no-daemon';
const REMOTE_FLAG = '--remote';

// Where Codex sends its ChatGPT sign-in: the endpoint its model requests go
// to, and the host the target's broker sets the access token on.
const CHATGPT_CODEX_URL = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_HOST = 'chatgpt.com';

// Codex's documented flag that runs hooks without the trust a person
// gives them in the TUI, meant for automation that vets its hook sources.
const HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';

// A config override on the command line, which outranks every config file.
const FILE_CREDENTIALS_OVERRIDE = 'cli_auth_credentials_store="file"';

// atc never writes the user's codex config: hooks are an entry the user installs and trusts
// once in the codex TUI
export function createCodexAdapter(
  entry: AgentEntry,
  config?: Pick<Config, 'authProfiles'>,
  codexHome?: string,
): CodexAdapter {
  const authProfiles: Config['authProfiles'] = config?.authProfiles ?? new Map();

  // The Codex home whose session index holds session titles; unset, it follows
  // `CODEX_HOME` or the user's home at each read.
  const resolveCodexHome = (): string => codexHome ?? resolveAgentHome('CODEX_HOME', '.codex');

  const planSpawn = (opts: SpawnOptions): SpawnPlan => ({
    bin: entry.bin,
    args: [
      // codex's shared background server runs every thread's hooks and tools in the environment
      // of the terminal that started it, so each terminal runs its own; configured arguments
      // that carry the flag or a remote server, which codex refuses to combine with it, add none
      ...(entry.args.some(isDaemonChoiceFlag) ? [] : [NO_DAEMON_FLAG]),

      // A model override replaces any model flag the configured arguments
      // carry, and travels as its own argument.
      ...(opts.model === undefined
        ? entry.args
        : [...buildArgsWithoutFlags(entry.args, CODEX_MODEL_FLAGS), '-m', opts.model]),

      // Bare resume opens Codex's own session picker; an id resumes that
      // session directly. Both accept a prompt afterwards.
      ...(opts.resume === true ? ['resume'] : []),
      ...(typeof opts.resume === 'string' ? ['resume', opts.resume] : []),
      ...(opts.prompt === '' ? [] : [opts.prompt]),
    ],
  });

  // The bridge owns the thread a terminal on its App Server joins, so a
  // resume through Codex's own session picker, which picks the thread in
  // the terminal, is refused rather than started as a new thread.
  const startAppServerBridge = (request: MessageBridgeRequest): Promise<MessageBridge> => {
    if (request.options.resume === true) {
      const refusal = new DaemonError(
        'unsupported',
        `agent '${entry.id}' runs on a Codex App Server, which resumes a session by its id and has no session picker`,
        { agent: entry.id },
      );

      return Promise.reject(refusal);
    }

    return startCodexAppServerBridge(request, {
      bin: entry.bin,
      planTerminal: (remote, thread) => planRemoteTerminal(request.options, remote, thread),
    });
  };

  // a terminal on the session's own app server resumes the bridge's thread there instead of
  // running a server of its own; a server choice in the configured arguments gives way to it
  const planRemoteTerminal = (opts: SpawnOptions, remote: string, thread: string): SpawnPlan => {
    const replaced = opts.model === undefined ? [REMOTE_FLAG] : [REMOTE_FLAG, ...CODEX_MODEL_FLAGS];

    const args = buildArgsWithoutFlags(
      entry.args.filter((arg) => arg !== NO_DAEMON_FLAG),
      replaced,
    );

    return {
      bin: entry.bin,
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
  };

  // without the broker a remote session runs as a local spawn plans it; behind the broker it needs
  // the atc inside its host to report, and its own codex home's hooks are trusted at launch, since
  // atc wrote them
  const planSignedInGuestSpawn = (opts: SpawnOptions, guest: GuestPaths): GuestSpawnPlan | null => {
    if (guest.auth === undefined) {
      return { ...planSpawn(opts), files: {} };
    }

    if (guest.atc === null) {
      return null;
    }

    const authDir = buildAuthRevisionFolder(guest.auth.revision);
    const signIn = requireSignIn(guest.auth.oauth ?? {});
    const plan = planSpawn(opts);

    // the flag outranks a trusted clone's own config, which could move the
    // sign-in out of the file atc writes
    const launch = buildCodexGuestLaunch(guest.directory, authDir, [
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
  };

  // The ID token claims and account id of the oauth secret this entry's
  // profiles send to chatgpt.com, or the refusal for a sign-in that is not
  // ready or that holds no account id.
  const requireSignIn = (
    states: Readonly<Record<string, GuestOAuthState>>,
  ): {
    readonly idClaims: Readonly<Record<string, unknown>>;
    readonly accountID: string;
  } => {
    const secret = findChatGPTSecret();
    const state = secret === null ? undefined : states[secret];
    const name = secret ?? 'the oauth secret';
    const renew = `sign Codex in again and give the broker the new refresh token for ${name}`;

    if (state?.status !== 'ready') {
      throw new DaemonError(
        'auth_signin_needed',
        `agent '${entry.id}' signs in through ${name}, whose sign-in in the broker is ${state?.status ?? 'not listed'}; ${renew}`,
        { agent: entry.id, secret, status: state?.status ?? null },
      );
    }

    const signIn = findCodexSignIn(state);

    if (signIn === null) {
      throw new DaemonError(
        'auth_signin_needed',
        `agent '${entry.id}' signs in through ${name}, whose ID token in the broker holds no ChatGPT account id; ${renew}`,
        { agent: entry.id, secret, status: state.status },
      );
    }

    return signIn;
  };

  // The secret this entry's profiles send to chatgpt.com, or null when
  // they no longer resolve to one.
  const findChatGPTSecret = (): string | null => {
    const auth = entry.auth;

    if (auth === undefined) {
      return null;
    }

    const resolution = resolveAuthProfiles(authProfiles, auth.profiles);

    if ('problem' in resolution) {
      return null;
    }

    const found = resolution.resolved.secrets.find((secret) =>
      secret.rules.some((rule) => rule.host === CHATGPT_HOST),
    );

    return found?.secret ?? null;
  };

  return {
    id: entry.id,
    hookAgent: 'codex',

    // Codex has no headless handoff.
    headlessRunner: null,

    // Codex's hooks are authoritative; no screen heuristics needed.
    screenDetector: null,

    profile: {
      label: entry.label,
      kind: 'codex',
      bin: entry.bin,
      models: null,
      spawnOptions: buildCodexSpawnOptions(entry.args),
    },

    // Only a session on an App Server of its own takes messages, through the
    // bridge the daemon runs beside it.
    takesMessages: entry.appServer === true,

    ...(entry.appServer === true ? { startMessageBridge: startAppServerBridge } : {}),

    planLineInput: planCodexLineInput,

    // A session resumes while its rollout exists.
    canResume: probeTranscriptResumable,

    ...(entry.auth === undefined ? {} : { planGuestSpawn: planSignedInGuestSpawn }),

    planSpawn,

    findAuthSelection: () => {
      const auth = entry.auth;

      if (auth === undefined) {
        return null;
      }

      return {
        gateway: { id: entry.id, baseURL: CHATGPT_CODEX_URL, auth },
        profiles: authProfiles,
        brokerRequired: false,
      };
    },

    planGuestWorkspaceTrust: (root) => {
      if (entry.auth === undefined) {
        return null;
      }

      return buildCodexTrustSeed(root);
    },

    planHookEvents: (hookEvent, previous) => planCodexHookEvents(hookEvent, previous),

    // Codex records session titles in the session index of its home.
    loadName: (source, namedBy) => loadCodexName(resolveCodexHome(), source, namedBy),

    planResumeCommand: (cwd, agentSessionID) => {
      const resume =
        agentSessionID === undefined ? 'codex resume' : `codex resume ${agentSessionID}`;

      return `cd ${toShellArg(cwd)} && ${resume}`;
    },
  };
}

// Whether a configured argument already decides which server a terminal
// uses: the flag that runs it without the shared one, or the remote server
// flag in either of its spellings.
function isDaemonChoiceFlag(arg: string): boolean {
  return arg === NO_DAEMON_FLAG || arg === REMOTE_FLAG || arg.startsWith(`${REMOTE_FLAG}=`);
}

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
