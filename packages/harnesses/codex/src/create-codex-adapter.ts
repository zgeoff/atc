import type { AgentEntry, Config } from '@atc/config';
import { resolveAuthProfiles } from '@atc/config';
import { resolveAgentHome, stateDir } from '@atc/config/host';
import type { AgentID } from '@atc/core';
import type {
  AgentAdapter,
  AgentHomeLocation,
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
  formatResumeCommand,
  makeAgentEnvFileSyncer,
  probeTranscriptResumable,
} from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { AgentSessionID } from '@atcx/contract';
import { startCodexAppServerBridge } from './app-server/start-codex-app-server-bridge';
import { buildCodexGuestLaunch } from './guest-launch/build-codex-guest-launch';
import { buildCodexHookFile } from './hooks/build-codex-hook-file';
import { planCodexHookEvents } from './hooks/plan-codex-hook-events';
import { loadCodexName } from './load-codex-name';
import { planCodexLineInput } from './plan-codex-line-input';
import { buildCodexTrustSeed } from './trust-seed/build-codex-trust-seed';

export interface CodexAdapter extends AgentAdapter {
  readonly hookAgent: AgentID;
  readonly profile: AgentProfile;

  readonly startMessageBridge?: (request: MessageBridgeRequest) => Promise<MessageBridge>;

  // Codex's TUI keeps a newline that arrives inside a burst of input, so a line is
  // pasted and then submitted. A slash command takes two pastes.
  readonly planLineInput: (text: string, modes: TerminalInputModes) => readonly LineInputStep[];

  readonly planGuestSpawn?: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;

  readonly findAuthSelection: () => AuthSelection | null;

  readonly planGuestWorkspaceTrust: (root: string) => Readonly<Record<string, string>> | null;

  readonly planResumeCommand: (
    cwd: string,
    agentSessionID: AgentSessionID | undefined,
  ) => string | null;
}

const CODEX_MODEL_FLAGS = ['-m', '--model'];
const NO_DAEMON_FLAG = '--no-daemon';
const REMOTE_FLAG = '--remote';
const CHATGPT_CODEX_URL = 'https://chatgpt.com/backend-api/codex';
const CHATGPT_HOST = 'chatgpt.com';
const HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';

// A config override on the command line, which outranks every config file.
const FILE_CREDENTIALS_OVERRIDE = 'cli_auth_credentials_store="file"';
const CODEX_HOME_LOCATION: AgentHomeLocation = { env: 'CODEX_HOME', folder: '.codex' };

export function createCodexAdapter(
  entry: AgentEntry,
  config?: Pick<Config, 'authProfiles'>,
  codexHome?: string,
  stateDirectory: string = stateDir,
): CodexAdapter {
  const authProfiles: Config['authProfiles'] = config?.authProfiles ?? new Map();
  const syncEnvFile = makeAgentEnvFileSyncer(entry, stateDirectory);

  const resolveCodexHome = (): string =>
    codexHome ?? resolveAgentHome(CODEX_HOME_LOCATION.env, CODEX_HOME_LOCATION.folder);

  const planSpawn = (opts: SpawnOptions): SpawnPlan => ({
    bin: entry.bin,
    args: [
      // Codex's shared background server runs every thread's hooks and tools in the environment
      // of the terminal that started it. Codex rejects the no-daemon option together with a
      // remote server, so omit it when the arguments already choose either.
      ...(entry.args.some(isDaemonChoiceFlag) ? [] : [NO_DAEMON_FLAG]),

      ...(opts.model === undefined
        ? entry.args
        : [...buildArgsWithoutFlags(entry.args, CODEX_MODEL_FLAGS), '-m', opts.model]),

      // A bare resume opens Codex's own session picker.
      ...(opts.resume === true ? ['resume'] : []),
      ...(typeof opts.resume === 'string' ? ['resume', opts.resume] : []),
      ...(opts.prompt === '' ? [] : [opts.prompt]),
    ],
    ...(Object.keys(entry.env).length === 0 ? {} : { env: entry.env }),
  });

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

  const planSignedInGuestSpawn = (opts: SpawnOptions, guest: GuestPaths): GuestSpawnPlan | null => {
    const env = { ...entry.env, ...guest.sessionEnv };

    if (guest.auth === undefined) {
      return { ...planSpawn(opts), ...(Object.keys(env).length === 0 ? {} : { env }), files: {} };
    }

    if (guest.atc === null) {
      return null;
    }

    const authDir = buildAuthRevisionFolder(guest.auth.revision);
    const signIn = requireSignIn(guest.auth.oauth ?? {});
    const plan = planSpawn(opts);

    // A command-line flag outranks a trusted clone's own config, which could move the
    // sign-in out of the file atc writes.
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
        [`${authDir}/config.toml`]: buildCodexConfig(guest.auth.telemetryHost ?? null),
        [`${authDir}/hooks.json`]: buildCodexHookFile([guest.atc]),
      },
      env: { ...env, ...guest.auth.profileEnv, ...guest.auth.env, ...launch.env },
    };
  };

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

    headlessRunner: null,

    screenDetector: null,

    profile: {
      label: entry.label,
      kind: 'codex',
      bin: entry.bin,
      models: null,
      spawnOptions: buildCodexSpawnOptions(entry.args),
    },

    takesMessages: entry.appServer === true,

    ...(entry.appServer === true ? { startMessageBridge: startAppServerBridge } : {}),

    planLineInput: planCodexLineInput,

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

    agentHomeLocation: CODEX_HOME_LOCATION,

    loadName: (source, namedBy, sessionHost) =>
      loadCodexName(
        sessionHost.agentHome ?? resolveCodexHome(),
        source,
        namedBy,
        sessionHost.files,
      ),

    planResumeCommand: (cwd, agentSessionID) => {
      const resume =
        agentSessionID === undefined ? 'codex resume' : `codex resume ${agentSessionID}`;

      return formatResumeCommand(cwd, resume, syncEnvFile());
    },
  };
}

function isDaemonChoiceFlag(arg: string): boolean {
  return arg === NO_DAEMON_FLAG || arg === REMOTE_FLAG || arg.startsWith(`${REMOTE_FLAG}=`);
}

// Codex documents reasoning effort as whatever the selected model advertises, with no
// closed list of levels, so no effort option is offered.
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
