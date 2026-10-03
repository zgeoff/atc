import { z } from 'zod';
import type { AgentID } from './agent-id';
import { buildOptionalStringArray } from './build-optional-string-array';
import type { AuthProfile } from './collect-auth-profiles';
import { isBrokerVariable } from './is-broker-variable';
import { isRecord } from './report';
import { resolveAuthProfiles } from './resolve-auth-profiles';

/**
 * The auth profiles a gateway's sessions are bound to through impd's
 * broker, and the variables each session gets in place of a credential,
 * every value the fixed placeholder.
 */
export interface GatewayAuth {
  readonly profiles: readonly string[];
  readonly placeholderEnv: Readonly<Record<string, string>>;
}

/**
 * A Claude-compatible backend the Claude CLI is pointed at: its own agent id,
 * its own row in the spawn menu, and its own generated settings file. The
 * credential is never held here: a helper command supplies it at run time,
 * or, with `auth`, impd's credential broker adds it to each request on the
 * host's side, so it stays out of the file atc writes.
 */
export interface GatewayConfig {
  readonly id: AgentID;
  readonly label: string;
  readonly mark: string;
  readonly bin: string;
  readonly args: readonly string[];
  readonly baseURL: string;
  readonly apiKeyHelper?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly auth?: GatewayAuth;
}

interface Gateways {
  readonly gateways: GatewayConfig[];

  // The problems that kept a gateway with `auth` out, one per problem.
  readonly errors: string[];
}

// Ids the built-in adapters answer to; a gateway may not take one.
const BUILT_IN_IDS = new Set(['claude', 'grok', 'codex']);

// One gateway map entry's keys. An absent or wrong-typed field parses to
// undefined rather than failing the entry, so a gateway with one bad field
// still registers with the default for it.
const GATEWAY_ENTRY_SCHEMA = z.object({
  label: buildOptionalNonEmptyString(),
  mark: buildOptionalNonEmptyString(),
  baseURL: buildOptionalNonEmptyString(),
  bin: buildOptionalNonEmptyString(),
  args: buildOptionalStringArray(),
  apiKeyHelper: buildOptionalNonEmptyString(),
  env: buildStringEnvRecord(),
  settings: buildOptionalSettings(),
});

/**
 * Reads the gateway map into menu order. An entry without a base URL, or
 * under an id another adapter already answers to, is left out rather than
 * registered half-formed: every gateway in the result can be spawned. A
 * gateway with `auth` is checked against the auth profiles, and one that
 * fails a check is left out with an error for each problem.
 */
export function collectGateways(
  raw: unknown,
  claudeBin: string,
  claudeArgs: readonly string[],
  authProfiles: ReadonlyMap<string, AuthProfile> = new Map(),
): Gateways {
  if (!isRecord(raw)) {
    return { gateways: [], errors: [] };
  }

  const gateways: GatewayConfig[] = [];
  const errors: string[] = [];

  for (const [id, entry] of Object.entries(raw)) {
    if (id === '' || BUILT_IN_IDS.has(id)) {
      continue;
    }

    const parsed = GATEWAY_ENTRY_SCHEMA.safeParse(entry);

    if (!parsed.success || parsed.data.baseURL === undefined) {
      continue;
    }

    let auth: GatewayAuth | undefined;

    if (isRecord(entry) && entry['auth'] !== undefined) {
      const checked = checkGatewayAuth(entry['auth'], parsed.data, authProfiles);

      if (Array.isArray(checked)) {
        errors.push(...checked.map((problem) => `gateways.${id}: ${problem}`));
        continue;
      }

      auth = checked;
    }

    const firstOfMark = (parsed.data.mark ?? id).codePointAt(0);

    gateways.push({
      id,
      label: parsed.data.label ?? id,

      // oxlint-disable-next-line no-unsafe-type-assertion -- mark falls back to id, and both are checked non-empty above, so codePointAt(0) always returns a code point
      mark: String.fromCodePoint(firstOfMark as number),
      bin: parsed.data.bin ?? claudeBin,
      args: parsed.data.args ?? claudeArgs,
      baseURL: parsed.data.baseURL,
      ...(parsed.data.apiKeyHelper === undefined ? {} : { apiKeyHelper: parsed.data.apiKeyHelper }),
      env: parsed.data.env,
      ...(parsed.data.settings === undefined ? {} : { settings: parsed.data.settings }),
      ...(auth === undefined ? {} : { auth }),
    });
  }

  return { gateways, errors };
}

interface GatewayEntry {
  readonly baseURL?: string | undefined;
  readonly apiKeyHelper?: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
}

// The gateway's auth, or every problem that refuses it. The checks cover
// each place a session's environment comes from: the gateway env, the
// settings env, and the placeholders, and which of them would win.
function checkGatewayAuth(
  raw: unknown,
  entry: GatewayEntry,
  authProfiles: ReadonlyMap<string, AuthProfile>,
): GatewayAuth | string[] {
  const auth = parseGatewayAuth(raw);

  if (typeof auth === 'string') {
    return [auth];
  }

  const problems: string[] = [];

  if (entry.apiKeyHelper !== undefined) {
    problems.push(
      'apiKeyHelper cannot be set together with auth, which supplies the credential through the broker',
    );
  }

  if (entry.settings?.['apiKeyHelper'] !== undefined) {
    problems.push(
      'settings.apiKeyHelper cannot be set together with auth, which supplies the credential through the broker',
    );
  }

  const settingsEnv = toEnvKeys(entry.settings?.['env']);

  problems.push(
    ...collectEnvProblems('env', Object.keys(entry.env)),
    ...collectEnvProblems('settings.env', settingsEnv),
    ...collectPlaceholderProblems(auth.placeholderEnv),
  );

  for (const key of Object.keys(auth.placeholderEnv)) {
    for (const [source, keys] of [
      ['env', Object.keys(entry.env)],
      ['settings.env', settingsEnv],
    ] as const) {
      if (keys.includes(key)) {
        problems.push(`placeholderEnv.${key} is also set in ${source}, which would override it`);
      }
    }
  }

  const resolution = resolveAuthProfiles(authProfiles, auth.profiles);

  if ('problem' in resolution) {
    problems.push(resolution.problem.message);
  } else {
    const hostProblem = findBaseURLProblem(entry.baseURL ?? '', resolution.resolved.hosts);

    if (hostProblem !== null) {
      problems.push(hostProblem);
    }
  }

  return problems.length > 0 ? problems : auth;
}

// The value every placeholder variable holds; impd's broker swaps the real
// credential in on the host's side.
const PLACEHOLDER = 'imp-broker-placeholder';

function parseGatewayAuth(raw: unknown): GatewayAuth | string {
  const profiles = isRecord(raw) ? raw['profiles'] : undefined;

  if (
    !isRecord(raw) ||
    !Array.isArray(profiles) ||
    profiles.length === 0 ||
    !profiles.every((name) => typeof name === 'string')
  ) {
    return 'auth must be an object with a non-empty profiles array';
  }

  const placeholderEnv = raw['placeholderEnv'] ?? {};

  if (!isRecord(placeholderEnv) || Array.isArray(placeholderEnv)) {
    return 'placeholderEnv must be an object of variable names';
  }

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(placeholderEnv)) {
    if (value !== PLACEHOLDER) {
      return `placeholderEnv.${key} must be ${PLACEHOLDER}`;
    }

    env[key] = value;
  }

  return { profiles: profiles.map(String), placeholderEnv: env };
}

// A settings env's variable names; anything but an object sets none.
function toEnvKeys(value: unknown): string[] {
  return isRecord(value) && !Array.isArray(value) ? Object.keys(value) : [];
}

// Variables Claude reads its endpoint and credential from. Only the
// placeholders may set a credential variable, and the base URL comes from
// `baseURL` alone, whose host is checked against the profiles.
const CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]);

const BASE_URL_VARIABLE = 'ANTHROPIC_BASE_URL';

function collectEnvProblems(source: string, keys: readonly string[]): string[] {
  return keys
    .filter(
      (key) => isBrokerVariable(key) || CREDENTIAL_VARIABLES.has(key) || key === BASE_URL_VARIABLE,
    )
    .map((key) => `${source} must not set ${key}`);
}

function collectPlaceholderProblems(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env)
    .filter((key) => isBrokerVariable(key) || key === BASE_URL_VARIABLE)
    .map((key) => `placeholderEnv must not set ${key}`);
}

// The broker matches a request by the exact host it connects to on the
// default https port, so the base URL must be https on that port, with a
// host one of the selected profiles covers.
function findBaseURLProblem(baseURL: string, hosts: readonly string[]): string | null {
  let url: URL;

  try {
    url = new URL(baseURL);
  } catch {
    return 'baseURL must be an https URL with no port or user info';
  }

  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return 'baseURL must be an https URL with no port or user info';
  }

  if (!hosts.includes(url.hostname)) {
    return `baseURL host ${url.hostname} is not a host of the selected profiles (${hosts.join(', ')})`;
  }

  return null;
}

// Claude Code settings the sessions of this gateway are started with, on top of
// the ones atc writes itself. Anything but an object is no extra settings.
function buildOptionalSettings() {
  return z.preprocess(
    (v) => (isRecord(v) ? v : undefined),
    z.record(z.string(), z.unknown()).optional(),
  );
}

function buildOptionalNonEmptyString() {
  return z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().optional(),
  );
}

// String values only: everything here is handed to a child process as an
// environment variable.
function buildStringEnvRecord() {
  return z.preprocess(
    (v) => {
      if (!isRecord(v)) {
        return {};
      }

      const env: Record<string, string> = {};

      for (const [key, value] of Object.entries(v)) {
        if (typeof value === 'string') {
          env[key] = value;
        }
      }

      return env;
    },
    z.record(z.string(), z.string()),
  );
}
