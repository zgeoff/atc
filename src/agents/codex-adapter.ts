import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AdapterEvent } from '../protocol/adapter-event';
import { DaemonError } from '../protocol/daemon-error';
import type { HookEvent } from '../protocol/hook-event';
import type { AgentID } from '../shared/agent-id';
import type { AgentSessionID } from '../shared/agent-session-id';
import { buildOptionalString } from '../shared/build-optional-string';
import type { AgentEntry } from '../shared/collect-agents';
import type { Config } from '../shared/config';
import { isRecord } from '../shared/report';
import { resolveAuthProfiles } from '../shared/resolve-auth-profiles';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toShellArg } from '../shared/to-shell-arg';
import { truncateDetail } from '../shared/truncate-detail';
import type {
  AgentAdapter,
  AgentProfile,
  AuthSelection,
  GuestOAuthState,
  GuestPaths,
  GuestSpawnPlan,
  NameUpdate,
  ResumeCheck,
  SpawnOptionSpecs,
  SpawnOptions,
  SpawnPlan,
} from './agent-adapter';
import { buildArgsWithoutFlags } from './build-args-without-flags';
import { buildCodexAuthFile } from './build-codex-auth-file';
import { buildCodexConfig } from './build-codex-config';
import { buildCodexGuestLaunch } from './build-codex-guest-launch';
import { buildCodexHookFile } from './build-codex-hook-file';
import { buildCodexTrustSeed } from './build-codex-trust-seed';
import { findFlagValue } from './find-flag-value';
import { planPastedLineInput } from './plan-pasted-line-input';
import { resolveAgentHome } from './resolve-agent-home';

// Codex's hook payload keys, snake_case. An absent or wrong-typed field
// parses to undefined rather than failing the payload, so a broken reporter
// never breaks the session it reports on.
const CODEX_HOOK_PAYLOAD_SCHEMA = z.object({
  session_id: buildOptionalString(),
  transcript_path: buildOptionalString(),
  prompt: buildOptionalString(),
  last_assistant_message: buildOptionalString(),
  tool_name: buildOptionalString(),
});

type CodexHookPayload = z.infer<typeof CODEX_HOOK_PAYLOAD_SCHEMA>;

// The spellings of the Codex CLI's model flag.
const CODEX_MODEL_FLAGS = ['-m', '--model'];

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

  readonly takesMessages = false;

  // Codex's TUI keeps a newline that arrives inside a burst of input, so a
  // line is pasted and then submitted.
  readonly planLineInput = planPastedLineInput;

  // Present only for an entry with `auth`: any other entry runs on a
  // remote host as a local spawn plans it, under the sign-in of the host's
  // image, and needs no atc there.
  readonly planGuestSpawn?: (opts: SpawnOptions, guest: GuestPaths) => GuestSpawnPlan | null;

  private readonly entry: AgentEntry;

  private readonly authProfiles: Config['authProfiles'];

  constructor(entry: AgentEntry, config?: Pick<Config, 'authProfiles'>) {
    this.entry = entry;
    this.authProfiles = config?.authProfiles ?? new Map();
    this.id = entry.id;

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

    const authDir = `auth-r${guest.auth.revision}`;
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

    const auth = state.idClaims?.[OPENAI_AUTH_CLAIM];
    const accountID = isRecord(auth) ? auth['chatgpt_account_id'] : undefined;

    if (state.idClaims === null || typeof accountID !== 'string' || accountID === '') {
      throw new DaemonError(
        'auth_signin_needed',
        `agent '${this.id}' signs in through ${name}, whose ID token in impd holds no ChatGPT account id; ${renew}`,
        { agent: this.id, secret, status: state.status },
      );
    }

    return { idClaims: state.idClaims, accountID };
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

  normalizeHook(e: HookEvent): AdapterEvent {
    const parsed = CODEX_HOOK_PAYLOAD_SCHEMA.safeParse(e.payload);
    const payload: CodexHookPayload = parsed.success ? parsed.data : {};

    const base: AdapterEvent = {
      kind: 'heartbeat',
      ...(payload.session_id === undefined
        ? {}
        : { agentSessionID: toAgentSessionID(payload.session_id) }),
    };

    const named: AdapterEvent = {
      ...base,
      ...(payload.session_id === undefined ? {} : { nameSource: payload.session_id }),
      ...(payload.transcript_path === undefined
        ? {}
        : { transcriptSource: payload.transcript_path }),
    };

    switch (e.event) {
      case 'SessionStart': {
        return { ...named, kind: 'started' };
      }
      case 'PermissionRequest': {
        const toolName = payload.tool_name;

        const message =
          toolName !== undefined && toolName !== ''
            ? `waiting for approval: ${toolName}`
            : 'waiting for approval';

        return { ...base, kind: 'needs-input', message, detail: message };
      }
      case 'UserPromptSubmit': {
        const preview = payload.prompt === undefined ? '' : payload.prompt.slice(0, 80);

        return {
          ...named,
          kind: 'prompt-submitted',
          ...(preview === '' ? {} : { message: preview, detail: truncateDetail(preview) }),
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
      case 'SessionEnd': {
        return { ...base, kind: 'ended' };
      }
      default: {
        return base;
      }
    }
  }

  // Codex records session titles in session_index.jsonl; the index does not
  // say whether a title was set by /rename or auto-generated, so a title
  // never overrides a user-typed name.
  loadName(source: string, namedBy: 'user' | 'auto' | 'agent'): Promise<NameUpdate | null> {
    if (namedBy === 'user') {
      return Promise.resolve(null);
    }

    const index = join(resolveAgentHome('CODEX_HOME', '.codex'), 'session_index.jsonl');
    let text: string;

    try {
      text = readFileSync(index, 'utf8');
    } catch {
      return Promise.resolve(null);
    }

    let name: string | undefined;

    for (const line of text.split('\n')) {
      if (line.trim() === '' || !line.includes(source)) {
        continue;
      }

      try {
        const parsed: unknown = JSON.parse(line);

        if (
          isRecord(parsed) &&
          parsed['id'] === source &&
          typeof parsed['thread_name'] === 'string'
        ) {
          name = parsed['thread_name'];
        }
      } catch {}
    }

    const update = name === undefined || name === '' ? null : { name };

    return Promise.resolve(update);
  }

  canResume(session: ResumeCheck): boolean {
    if (session.transcriptSource === undefined) {
      return true;
    }

    return existsSync(session.transcriptSource);
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

// The ID token claim that holds the ChatGPT account and plan.
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

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
