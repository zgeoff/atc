import { collectProfileEnvProblems, resolveAuthProfiles } from '@atc/config';
import {
  BROKER_PLACEHOLDER,
  CLAUDE_CREDENTIAL_VARIABLES,
  isBrokerVariable,
  isRecord,
} from '@atc/core';
import type { AuthProfile, GatewayAuth } from '@atc/plugin-api';

interface GatewayAuthEntry {
  readonly baseURL?: string | undefined;
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

  if (entry.settings?.['apiKeyHelper'] !== undefined) {
    problems.push(
      'settings.apiKeyHelper cannot be set together with auth; apiKeyHelper holds the credential helper of a launch without the broker',
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
    if (value !== BROKER_PLACEHOLDER) {
      return `placeholderEnv.${key} must be ${BROKER_PLACEHOLDER}`;
    }

    env[key] = value;
  }

  const args = raw['args'];

  if (args === undefined) {
    return { profiles: profiles.map(String), placeholderEnv: env };
  }

  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return 'auth.args must be an array of strings';
  }

  return { profiles: profiles.map(String), placeholderEnv: env, args: args.map(String) };
}

// A settings env's variable names; anything but an object sets none.
function toEnvKeys(value: unknown): string[] {
  return isRecord(value) && !Array.isArray(value) ? Object.keys(value) : [];
}

// Variables Claude reads its endpoint and credential from. Only the
// placeholders may set a credential variable, and the base URL comes from
// `baseURL` alone, whose host is checked against the profiles.
const CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  CLAUDE_CREDENTIAL_VARIABLES.authToken,
  CLAUDE_CREDENTIAL_VARIABLES.apiKey,
]);

function collectEnvProblems(source: string, keys: readonly string[]): string[] {
  return keys
    .filter(
      (key) =>
        isBrokerVariable(key) ||
        CREDENTIAL_VARIABLES.has(key) ||
        key === CLAUDE_CREDENTIAL_VARIABLES.baseURL,
    )
    .map((key) => `${source} must not set ${key}`);
}

function collectPlaceholderProblems(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env)
    .filter((key) => isBrokerVariable(key) || key === CLAUDE_CREDENTIAL_VARIABLES.baseURL)
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
