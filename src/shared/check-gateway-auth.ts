import type { AuthProfile } from './collect-auth-profiles';
import { collectProfileEnvProblems } from './collect-profile-env-problems';
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
 * The fields of a gateway entry that its auth is checked against.
 */
interface GatewayAuthEntry {
  readonly baseURL?: string | undefined;
  readonly apiKeyHelper?: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
}

// The gateway's auth, or every problem that refuses it. The checks cover
// each place a session's environment comes from: the gateway env, the
// settings env, and the placeholders, and which of them would win.
export function checkGatewayAuth(
  raw: unknown,
  entry: GatewayAuthEntry,
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
    problems.push(
      ...collectProfileEnvProblems(
        [
          ['env', Object.keys(entry.env)],
          ['settings.env', settingsEnv],
        ],
        resolution.resolved.envOwners,
      ),
    );

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
