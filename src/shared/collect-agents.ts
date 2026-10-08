import type { AgentID } from './agent-id';
import { checkGatewayAuth } from './check-gateway-auth';
import type { GatewayAuth } from './check-gateway-auth';
import type { AuthProfile } from './collect-auth-profiles';
import { collectClaudeAuth } from './collect-claude-auth';
import type { ClaudeMCPServer } from './collect-claude-auth';
import { collectCodexAuth } from './collect-codex-auth';
import { collectProfileEnvProblems } from './collect-profile-env-problems';
import { isSubscriptionOverrideVariable } from './is-subscription-override-variable';
import { isRecord } from './report';
import { resolveAuthProfiles } from './resolve-auth-profiles';

/**
 * The agent CLI an entry drives, which decides the adapter behind it.
 */
type AgentKind = 'claude' | 'codex' | 'grok';

/**
 * One agent atc offers: its id, how it appears in the spawn menu, the binary
 * and arguments it starts with, and, for a Claude entry, the settings, the
 * environment, and the backend and credential it runs against. A Claude entry
 * with a `baseURL` is a gateway; without one it is stock Claude, whose
 * `auth` holds profiles alone, for the subscription sign-in, and whose
 * `mcpServers` reach their hosts through those profiles. A Codex entry's
 * `auth` holds profiles alone too, for its ChatGPT sign-in.
 */
export interface AgentEntry {
  readonly id: AgentID;
  readonly kind: AgentKind;
  readonly label: string;
  readonly mark: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly baseURL?: string;
  readonly apiKeyHelper?: string;
  readonly auth?: GatewayAuth;
  readonly mcpServers?: readonly ClaudeMCPServer[];
}

interface CollectedAgents {
  readonly agents: AgentEntry[];

  // One line per problem, each starting with the entry it refused.
  readonly errors: string[];
}

/**
 * Reads the `agents` map into registry order. An entry that is not an object,
 * sets an unknown field or a field outside its kind, holds a wrong-typed
 * value, or fails an auth check is left out with every problem that refused
 * it, and the other entries load. An MCP server that breaks a rule is left
 * out of its entry with an error, and the entry loads. A value that is not an object leaves the
 * registry empty.
 */
export function collectAgents(
  raw: unknown,
  authProfiles: ReadonlyMap<string, AuthProfile> = new Map(),
): CollectedAgents {
  if (!isRecord(raw) || Array.isArray(raw)) {
    return { agents: [], errors: ['agents must be an object of agent entries'] };
  }

  const agents: AgentEntry[] = [];
  const errors: string[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    const parsed = parseAgentEntry(id, entry, authProfiles);

    if ('problems' in parsed) {
      errors.push(...parsed.problems.map((problem) => `agents.${id}: ${problem}`));
    } else {
      agents.push(parsed.entry);
      errors.push(...(parsed.warnings ?? []).map((warning) => `agents.${id}: ${warning}`));
    }
  }

  return { agents, errors };
}

const KINDS: readonly AgentKind[] = ['claude', 'codex', 'grok'];

function isAgentKind(value: unknown): value is AgentKind {
  return KINDS.some((kind) => kind === value);
}

// The fields every kind takes, and the ones each kind takes beside them.
const COMMON_FIELDS = new Set(['kind', 'label', 'mark', 'bin', 'args']);

const KIND_FIELDS: Readonly<Record<AgentKind, ReadonlySet<string>>> = {
  claude: new Set(['settings', 'env', 'baseURL', 'apiKeyHelper', 'auth']),
  codex: new Set(['auth']),
  grok: new Set(),
};

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  ...COMMON_FIELDS,
  ...KIND_FIELDS.claude,
  ...KIND_FIELDS.codex,
  ...KIND_FIELDS.grok,
]);

const DEFAULT_LABELS: Readonly<Record<AgentKind, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
};

type ParsedEntry =
  | { readonly entry: AgentEntry; readonly warnings?: readonly string[] }
  | { readonly problems: string[] };

function parseAgentEntry(
  id: string,
  raw: unknown,
  authProfiles: ReadonlyMap<string, AuthProfile>,
): ParsedEntry {
  if (id === '' || id === '__proto__') {
    return { problems: ['the id cannot be used'] };
  }

  if (!isRecord(raw) || Array.isArray(raw)) {
    return { problems: ['the entry must be an object'] };
  }

  const found = findKind(id, raw['kind']);

  if ('problem' in found) {
    return { problems: [found.problem] };
  }

  const problems = collectFieldProblems(raw, found.kind);

  if (problems.length > 0) {
    return { problems };
  }

  const entry = buildEntry(id, found.kind, raw);

  if (found.kind === 'codex') {
    return readCodexAuth(entry, raw['auth'], authProfiles);
  }

  if (found.kind !== 'claude') {
    return { entry };
  }

  const claude = readClaudeAuth(entry, raw['auth'], authProfiles);

  if ('problems' in claude) {
    return claude;
  }

  const { warnings, ...read } = claude;

  return { entry: { ...entry, ...read }, ...(warnings === undefined ? {} : { warnings }) };
}

// The entry's kind, or the problem that refuses it. An absent kind is the id
// for one of the three ids that name a kind, and a problem for any other.
function findKind(
  id: string,
  raw: unknown,
): { readonly kind: AgentKind } | { readonly problem: string } {
  const named = KINDS.find((kind) => kind === id);

  if (raw === undefined) {
    return named === undefined
      ? { problem: 'kind is required for an id other than claude, codex, or grok' }
      : { kind: named };
  }

  if (!isAgentKind(raw)) {
    return { problem: 'kind must be claude, codex, or grok' };
  }

  if (named !== undefined && named !== raw) {
    return { problem: `kind ${raw} contradicts the id ${id}` };
  }

  return { kind: raw };
}

function collectFieldProblems(raw: Readonly<Record<string, unknown>>, kind: AgentKind): string[] {
  const problems: string[] = [];

  for (const [name, value] of Object.entries(raw)) {
    if (!KNOWN_FIELDS.has(name)) {
      problems.push(`unknown field ${name}`);
      continue;
    }

    if (!COMMON_FIELDS.has(name) && !KIND_FIELDS[kind].has(name)) {
      problems.push(`${name} is not valid for kind ${kind}`);
      continue;
    }

    const problem = findFieldProblem(name, value);

    if (problem !== null) {
      problems.push(problem);
    }
  }

  return problems;
}

// The problem with one field's value, or null. `kind` and `auth` are checked
// elsewhere.
function findFieldProblem(name: string, value: unknown): string | null {
  switch (name) {
    case 'label':
    case 'mark':
    case 'bin':
    case 'baseURL':
    case 'apiKeyHelper': {
      return typeof value === 'string' && value !== ''
        ? null
        : `${name} must be a non-empty string`;
    }
    case 'args': {
      return Array.isArray(value) && value.every((arg) => typeof arg === 'string')
        ? null
        : 'args must be an array of strings';
    }
    case 'env': {
      return isStringRecord(value) ? null : 'env must be an object of strings';
    }
    case 'settings': {
      return isRecord(value) && !Array.isArray(value) ? null : 'settings must be an object';
    }
    default: {
      return null;
    }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

// An entry with every default applied, from fields already checked.
function buildEntry(
  id: string,
  kind: AgentKind,
  raw: Readonly<Record<string, unknown>>,
): AgentEntry {
  const label = raw['label'];
  const mark = raw['mark'];
  const bin = raw['bin'];
  const args = raw['args'];
  const env = raw['env'];
  const settings = raw['settings'];
  const baseURL = raw['baseURL'];
  const apiKeyHelper = raw['apiKeyHelper'];
  const markSource = typeof mark === 'string' ? mark : id;

  return {
    id,
    kind,
    label: typeof label === 'string' ? label : buildDefaultLabel(id, kind),
    mark: String.fromCodePoint(markSource.codePointAt(0) ?? 0),
    bin: typeof bin === 'string' ? bin : kind,
    args: Array.isArray(args) ? args.map(String) : [],
    env: isStringRecord(env) ? env : {},
    ...(isRecord(settings) ? { settings } : {}),
    ...(typeof baseURL === 'string' ? { baseURL } : {}),
    ...(typeof apiKeyHelper === 'string' ? { apiKeyHelper } : {}),
  };
}

// The three ids that name a kind show that kind's name; any other id shows
// itself.
function buildDefaultLabel(id: string, kind: AgentKind): string {
  return id === kind ? DEFAULT_LABELS[kind] : id;
}

// A Codex entry with the `auth` it holds, or every problem with that auth.
// Codex takes no placeholder variable: atc writes the sign-in file the CLI
// reads in place of a credential.
function readCodexAuth(
  entry: AgentEntry,
  raw: unknown,
  authProfiles: ReadonlyMap<string, AuthProfile>,
): ParsedEntry {
  if (raw === undefined) {
    return { entry };
  }

  const collected = collectCodexAuth(raw, authProfiles);

  if (collected.profiles === null) {
    return { problems: [...collected.errors] };
  }

  return { entry: { ...entry, auth: { profiles: collected.profiles, placeholderEnv: {} } } };
}

interface ReadClaudeAuth {
  readonly auth?: GatewayAuth;
  readonly mcpServers?: readonly ClaudeMCPServer[];
  readonly warnings?: readonly string[];
}

// The `auth` a Claude entry holds, or every problem with it. With a base URL
// the entry is a gateway and its auth is the gateway's. Without one it is
// stock Claude, whose auth is profiles alone and whose environment may not
// override or route around the subscription sign-in.
function readClaudeAuth(
  entry: AgentEntry,
  raw: unknown,
  authProfiles: ReadonlyMap<string, AuthProfile>,
): ReadClaudeAuth | { readonly problems: string[] } {
  if (entry.baseURL !== undefined) {
    if (raw === undefined) {
      return {};
    }

    const checked = checkGatewayAuth(
      raw,
      {
        baseURL: entry.baseURL,
        env: entry.env,
        settings: entry.settings,
      },
      authProfiles,
    );

    return Array.isArray(checked) ? { problems: checked } : { auth: checked };
  }

  const problems =
    entry.apiKeyHelper === undefined ? [] : ['apiKeyHelper is only valid together with baseURL'];

  if (raw === undefined) {
    return problems.length > 0 ? { problems } : {};
  }

  const collected = collectClaudeAuth(raw, authProfiles, 'auth');

  problems.push(...collectSubscriptionProblems(entry));

  if (collected.auth !== null) {
    problems.push(...collectEntryProfileEnvProblems(entry, collected.auth.profiles, authProfiles));
  }

  if (collected.auth === null) {
    return { problems: [...collected.errors, ...problems] };
  }

  if (problems.length > 0) {
    return { problems };
  }

  return {
    auth: { profiles: collected.auth.profiles, placeholderEnv: {} },
    ...(collected.auth.mcpServers.length === 0 ? {} : { mcpServers: collected.auth.mcpServers }),
    warnings: collected.errors,
  };
}

// The variables a stock entry sets that its selected profiles also set.
function collectEntryProfileEnvProblems(
  entry: AgentEntry,
  selected: readonly string[],
  authProfiles: ReadonlyMap<string, AuthProfile>,
): string[] {
  const resolution = resolveAuthProfiles(authProfiles, selected);

  if ('problem' in resolution) {
    return [];
  }

  const settingsEnv = entry.settings?.['env'];

  return collectProfileEnvProblems(
    [
      ['env', Object.keys(entry.env)],
      [
        'settings.env',
        isRecord(settingsEnv) && !Array.isArray(settingsEnv) ? Object.keys(settingsEnv) : [],
      ],
    ],
    resolution.resolved.envOwners,
  );
}

// What a stock entry with `auth` sets that would override the subscription
// sign-in or route the CLI around impd's broker.
function collectSubscriptionProblems(entry: AgentEntry): string[] {
  const settingsEnv = entry.settings?.['env'];

  const settingsKeys =
    isRecord(settingsEnv) && !Array.isArray(settingsEnv) ? Object.keys(settingsEnv) : [];

  const problems = [
    ...Object.keys(entry.env)
      .filter((key) => isSubscriptionOverrideVariable(key))
      .map((key) => `env must not set ${key}${OVERRIDE_REASON}`),
    ...settingsKeys
      .filter((key) => isSubscriptionOverrideVariable(key))
      .map((key) => `settings.env must not set ${key}${OVERRIDE_REASON}`),
  ];

  if (entry.settings?.['apiKeyHelper'] !== undefined) {
    problems.push(
      'settings.apiKeyHelper must not be set, which would override the subscription sign-in',
    );
  }

  return problems;
}

const OVERRIDE_REASON = ', which would override or route around the subscription sign-in';
